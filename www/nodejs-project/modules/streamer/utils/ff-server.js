const fs = require('fs'), http = require('http'), path = require('path'), finished = require('on-finished'), decodeEntities = require('decode-entities'), Events = require('events')

class FFServer extends Events {
    constructor(source, opts){
        super()
        this.source = source 
        this.timeout = 30
        this.timeoutTimer = 0
        this.started = false
        this.type = 'ffserver'
        this.opts = {
            debug: false,
            workDir: process.cwd(),
            addr: '127.0.0.1',
            port: 0,
            videoCodec: 'copy',
            audioCodec: 'copy',
            inputFormat: null
        };
        this.setOpts(opts)
    }
    setOpts(opts){
        if(opts && typeof(opts) == 'object'){     
            Object.keys(opts).forEach((k) => {
                if(['debug'].indexOf(k) == -1 && typeof(opts[k]) == 'function'){
                    this.on(k, opts[k])
                } else {
                    this.opts[k] = opts[k]
                }
            })
        }
    }
    genUID(cb){          
        if(!this.uid){
            this.uid = parseInt(Math.random() * 1000000000)
        }
        fs.readdir(this.opts.workDir, (err, files) => {
            if(err){
                fs.mkdir(path.dirname(this.opts.workDir), {recursive: true}, cb)
            } else if(Array.isArray(files)) {
                while(files.includes(String(this.uid))) {
                    this.uid++
                }
                cb()
            }
        })
    }
    time(){
		return ((new Date()).getTime() / 1000)
	}
    waitDecoder(){
        return new Promise((resolve, reject) => {
            let started, failed, intervalTimer = setInterval(() => {
                if(this.destroyed){
                    return reject('destroyed')
                }
                if(this.decoder && this.decoder.file){
                    fs.stat(this.decoder.file, (err, stat) => {
                        if(!err && stat.size) { 
                            started = true
                            clearInterval(intervalTimer)
                            resolve()
                        }
                    })
                } else {
                    failed = true
                    clearInterval(intervalTimer)
                    reject('no file specified')
                }
            }, 1000)
            this.timeoutTimer = setTimeout(() => {
                if(!started && !failed){
                    failed = true
                    clearInterval(intervalTimer)
                    reject('timeout')
                }
            }, this.timeout * 1000)
        })
    }
    proxify(file){
        if(typeof(file)=='string'){
            if(file.indexOf(this.uid) != -1){
                file = file.split(this.uid)[1]
            }
            if(!this.opts.port){
                return file // server not ready
            }
            file = 'http://127.0.0.1:' + this.opts.port + file.replaceAll('\\', '/')
        }
        return file
    }
    unproxify(url){
        if(typeof(url)=='string'){
            if(url.charAt(0) == '/'){
                url = url.slice(1)
            }
            url = url.replace(new RegExp('^.*:[0-9]+/+'), '')
            if(url.indexOf('&') != -1 && url.indexOf(';') != -1){
                url = decodeEntities(url)
            }
            url = url.split('?')[0].split('#')[0]
            url = path.resolve(this.opts.workDir + path.sep + this.uid + path.sep + url)
        }
        return url
    }
    serve(){
        return new Promise((resolve, reject) => {
            this.server = http.createServer((req, response) => {
				var file = this.unproxify(req.url.split('#')[0])
                fs.stat(file, (err, stat) => {
                    //console.log('FFMPEG SERVE', file, stat)
                    if (!stat || !stat.size) {
                        response.writeHead(404, { 
                            'Content-Type': 'text/plain',
                            'Access-Control-Allow-Origin': '*'
                        })
                        response.end('404 Not Found\n')
                        return
                    }
                    let headers = {
                        'Access-Control-Allow-Origin': '*'
                    }
                    switch(global.streamer.ext(file)){
                        case 'm3u8':
                            headers['content-type'] =  'application/x-mpegURL'
                            break
                        case 'mp4':
                        case 'm4v':
                            headers['content-type'] =  'video/mp4'
                            break
                        case 'm4s':
                            headers['content-type'] = 'video/iso.segment'
                            break
                        case 'ts':
                        case 'mpegts':
                        case 'mts':
                            headers['content-type'] =  'video/MP2T'
                            break
                    }
                    let ended, stream = fs.createReadStream(file)
                    response.writeHead(200, headers)
                    if(this.listenerCount('data') && headers['content-type'] && headers['content-type'].substr(0, 6) == 'video/'){
                        let offset = 0
                        stream.on('data', chunk => {
                            let len = chunk.length
                            this.emit('data', req.url, chunk, len, offset)
                            offset += len
                        })
                    }
                    const end = () => {
                        if(!ended){
                            ended = true
                            stream && stream.destroy()
                            response.end()
                        }
                    }
                    finished(response, end)
                    /*
                    req.on('close', () => { // req disconnected
                        if(!ended){
                            console.warn('client aborted the request')
                            end()
                        }
                    })
                    */
                    stream.pipe(response) 
                })
            }).listen(0, this.opts.addr, (err) => {
                if (err) {
                    return reject('unable to listen on any port')
                }
                this.opts.port = this.server.address().port
                this.endpoint = this.proxify(this.decoder.file)
                console.log('FFMPEG SERVE', this.decoder.file)
                this.emit('ready')
                resolve()
            })
        })
    }
    start(){
        return new Promise((resolve, reject) => {
            const startTime = this.time()
            this.genUID(() => {
                let cores = Math.min(require('os').cpus().length, 2), fragTime = 4, lwt = global.config.get('live-window-time')
                if(typeof(lwt) != 'number'){
                    lwt = 120
                } else if(lwt < 30) { // too low will cause isBehindLiveWindowError
                    lwt = 30
                }
                let hlsListSize = Math.ceil(lwt / fragTime)
                this.decoder = global.ffmpeg.create(this.source).
                    // inputOptions('-re').
                    // inputOption('-ss', 1). // https://trac.ffmpeg.org/ticket/2220
                    //inputOptions('-fflags +genpts').
                    addOption('-threads', cores).
                    addOption('-max_muxing_queue_size', 2048). // https://stackoverflow.com/questions/49686244/ffmpeg-too-many-packets-buffered-for-output-stream-01
                    addOption('-err_detect', 'ignore_err').
                    // addOption('-analyzeduration 2147483647').
                    // addOption('-probesize', '2147483647').
                    // addOption('-vf', 'setpts=PTS').
                    // addOption('-vsync', '1').
                    // addOption('-vsync', '0').
                    // addOption('-async', '-1').
                    // addOption('-async', '2').
                    addOption('-strict', '-2').
                    // addOption('-flags:a', '+global_header').
                    addOption('-hls_flags', 'delete_segments'). // ?? https://www.reddit.com/r/ffmpeg/comments/e9n7nb/ffmpeg_not_deleting_hls_segments/
                    addOption('-hls_init_time', 2). // 1 may cause manifestParsingError "invalid target duration"
                    addOption('-hls_time', fragTime).
                    addOption('-hls_list_size', hlsListSize).
                    addOption('-map', '0:a?').
                    addOption('-map', '0:v?').
                    // addOption('-packetsize', 188).
                    addOption('-loglevel', 'error').
                    addOption('-sn').
                    addOption('-preset', 'ultrafast').
                    format('hls')
                if(this.opts.inputFormat){
                    this.decoder.inputOption('-f', this.opts.inputFormat)
                }
                if(this.opts.audioCodec){
                    this.decoder.audioCodec(this.opts.audioCodec)
                }
                if(this.opts.videoCodec === null){
                    this.decoder.addOption('-vn')
                } else if(this.opts.videoCodec) {
                    this.decoder.videoCodec(this.opts.videoCodec)                
                }
                this.decoder.log = []
                if(this.opts.videoCodec == 'libx264') {
                    this.decoder.
                    /* HTML5 compat start */
                    addOption('-profile:v', 'baseline').
                    addOption('-shortest').
                    addOption('-pix_fmt', 'yuv420p').
                    addOption('-preset:v', 'ultrafast').
                    addOption('-movflags', '+faststart').
                    /* HTML5 compat end */

                    addOption('-crf', 18) // we are encoding for watching, so avoid to waste too much time and cpu with encoding, at cost of bigger disk space usage
                }
                if(this.opts.audioCodec == 'aac'){
                    this.decoder.addOption('-profile:a', 'aac_low').
                    addOption('-preset:a', 'ultrafast').
                    addOption('-b:a', '128k').
                    addOption('-ac', '2').
                    addOption('-ar', '48000').
                    addOption('-af', 'aresample=async=1:min_hard_comp=0.100000:first_pts=0')      
                }
                if (typeof(this.source) == 'string' && this.source.indexOf('http') == 0) { // skip other protocols
                    this.decoder.
                        inputOptions('-stream_loop -1').
                        // inputOptions('-timeout -1').
                        inputOptions('-reconnect 1').
                        // inputOptions('-reconnect_at_eof 1').
                        inputOptions('-reconnect_streamed 1').
                        inputOptions('-reconnect_delay_max 20')
                    this.decoder.
                    inputOptions('-icy 0').
                    inputOptions('-seekable -1').
                    inputOptions('-multiple_requests 1')
                    if(this.agent){
                        this.decoder.inputOptions('-user_agent', '"' + this.agent + '"') //  -headers ""
                    }
                    if (this.source.indexOf('https') == 0) {
                        this.decoder.inputOptions('-tls_verify 0')
                    }
                }
                this.decoder.
                on('end', () => {
                    if(!this.destroyed){
                        console.warn('file ended', traceback())
                        // this.retry() // will already call error on fail
                        this.destroy()
                    }
                }).
                on('error', (err) => {
                    if(!this.destroyed && this.decoder){
                        console.error('an error happened after '+ (this.time() - startTime) +'s: ' + err.message, this.decoder)
                        err = err.message || err || 'ffmpeg fail'
                        let m = err.match(new RegExp('Server returned ([0-9]+)'))
                        if(m && m.length > 1){
                            err = parseInt(m[1])
                        }
                        this.emit('fail', err)
                    }
                }).
                on('start', (commandLine) => {
                    if(this.destroyed){ // already destroyed
                        return
                    }
                    console.log('Spawned FFmpeg with command: ' + commandLine, 'file:', this.decoder.file, 'workDir:', this.opts.workDir, 'cwd:', process.cwd(), 'PATHs', global.paths, 'cordova:', !!global.cordova)
                    // setPriority('idle', this.decoder.ffmpegProc.pid) // doesnt't help on tuning performance
                    // ok, but wait file creation to trigger "start"
                }).
                on('stderr', (stderrLine) => {
                    if(this.opts.debug){
                        this.opts.debug(stderrLine)
                    }
                    console.log('ffmpeg stderr: '+ stderrLine)
                    if(!this.destroyed){
                        if(!stderrLine.match(new RegExp('frame=.*fps=', 'i'))){
                            this.decoder.log.push(stderrLine)
                        }
                    }
                })
                this.decoder.file = path.resolve(this.opts.workDir + path.sep + this.uid + path.sep + 'output.m3u8')
                fs.mkdir(path.dirname(this.decoder.file), {
                    recursive: true
                }, () => {
                    if(this.destroyed){
                        return
                    }
                    fs.access(path.dirname(this.decoder.file), fs.constants.W_OK, (err) => {
                        if(this.destroyed){
                            return
                        }
                        if(err){
                            console.error('FFMPEG cannot write', err)
                            reject('playback')
                        } else {
                            console.log('FFMPEG run: '+ this.source, this.decoder.file)
                            this.decoder.output(this.decoder.file).run()
                            this.emit('decoder', this.decoder)
                            this.waitDecoder().then(() => {
                                this.serve().then(resolve).catch(reject)
                            }).catch(e => {
                                console.error('waitDecoder timeout', this.decoder ? this.decoder.log : null, e)
                                this.destroy()
                                reject(e)
                            })
                        }
                    })
                })
            })
        })
    }
    destroy(){
        this.destroyed = true
        if(this.decoder){
            const file = this.decoder.file
            console.log('ffmpeg destroy: '+ file, global.traceback())
            this.decoder.kill()
            if(file){
                global.removeFolder(path.dirname(file), true)
            }
            this.decoder = null
        }
        if(this.server){
            this.server.close()
            this.server = null
        }
    }
}

module.exports = FFServer

