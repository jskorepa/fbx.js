require('source-map-support').install()
import * as fbx from '../lib'
import * as fs from 'fs'

(async () => {
    try {
        if(process.argv.length < 3) {
            console.error('Specify file to dump')
            return
        }
        const { buffer } = fs.readFileSync(process.argv[2])
        const arr = new Uint8Array(buffer, 0, buffer.byteLength)
        const parsed = await fbx.parse(arr)
        const serialized = await fbx.serialize(parsed)
        fs.writeFileSync(process.argv[3], new Buffer(serialized.buffer))
    } catch(e) {
        console.error(e)
    }
    //await fbx.parse(buffer)
})()
