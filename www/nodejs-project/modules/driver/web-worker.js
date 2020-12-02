
const fs = require('fs')

function logErr(data){
    postMessage({id: -1, type: 'error', data})
}

process.on('unhandledRejection', (reason, promise) => {
    const msg = 'Unhandled Rejection at: '+ String(promise) + ', reason: '+ String(reason)
    logErr(msg)
})
process.on('uncaughtException', (exception) => {
	const msg = 'uncaughtException: '+ JSON.stringify(exception.stack)
    logErr(msg)
    return false
})

let workerData = JSON.parse(self.name)
if(workerData){
    Object.keys(workerData).forEach(k => global[k] = workerData[k])
}

const Config = require(APPDIR + '/modules/config')
global.config = new Config(global.paths['data'] + '/config.json')

if(global.bytenode){
    global.bytenode = require('bytenode')
}

const Driver = require(file), driver = new Driver()
onmessage = e => {
    const msg = e.data
    if(msg.method == 'configChange'){
        global.config.reload()
    } else if(typeof(driver[msg.method]) == 'undefined'){
        postMessage({id: msg.id, type: 'reject', data: 'method not exists ' + JSON.stringify(msg.data)})
    } else {
        let type, data = null
        let call = driver[msg.method].apply(driver, msg.args)
        if(call && call.then){
            call.then(ret => {
                type = 'resolve'
                data = ret
            }).catch(err => {
                type = 'reject'
                data = err
            }).finally(() => {
                try {
                    postMessage({id: msg.id, type, data})
                } catch(err) {
                    console.error('driver.postMessage error', err, {id: msg.id, type, data}, file)
                }
            })
        }
    }
}

