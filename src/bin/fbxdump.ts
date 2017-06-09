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
        console.log(JSON.stringify(
            parsed, (_key, value: any) => {
                if(typeof value === 'object' && value) {
                    const val = <fbx.FBXProperty>value
                    if(val.type === 'R') {
                        const view = new DataView(val.value.buffer)
                        let ret = ''
                        for(let i = 0; i < val.value.byteLength; i++) {
                            ret += view.getInt8(i)+' '
                        }
                        return {
                            type: 'R',
                            value: ret,
                        }
                    }
                }
                return value
            }, 2,
        ))
    } catch(e) {
        console.error(e)
    }
    //await fbx.parse(buffer)
})()
