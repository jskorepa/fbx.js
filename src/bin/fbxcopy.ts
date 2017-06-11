require('source-map-support').install()
import * as fbx from '../lib'
import * as fs from 'fs'

const argPos = (arg: string) => process.argv.indexOf(arg, 2)
const hasArg = (arg: string) => argPos(arg) >= 0
const argValue = (arg: string) => {
    const pos = argPos(arg)
    if(pos < 0) return false
    const val = process.argv[pos + 1]
    if(val.indexOf('--') === 0) return false
    return val
}

;(async () => {
    try {
        const from = argValue('--from')
        const to = argValue('--to')
        if(!from) {
            console.error('Specify --from argument')
            return process.exit(1)
        }
        if(!to) {
            console.error('Specify --to argument')
            return process.exit(1)
        }
        console.time('read')
        const { buffer } = fs.readFileSync(from)
        console.timeEnd('read')
        const arr = new Uint8Array(buffer, 0, buffer.byteLength)
        console.time('parse')
        const parsed = await fbx.parse(arr)
        console.timeEnd('parse')
        const getUID = (node: fbx.FBXNode) => {
            if(!node.properties) throw new Error('Invalid FBX file')
            const prop = node.properties[0]
            if(prop.type !== 'L') throw new Error('Invalid FBX file')
            return prop.value
        }
        if(hasArg('--deduplicate') || hasArg('-d')) {
            console.time('deduplicate')
            const idReplaceMap: {
                [low: number]: {
                    [high: number]: { low: number, high: number },
                },
            } = {}

            const objectsNode = parsed.children.filter(a => a.name === 'Objects')[0]
            if(!objectsNode.children) throw new Error('No Objects node in fbx file')
            const objects = objectsNode.children || []
            const objectsJSON = objects.map(o => JSON.stringify(o.children))
            for(let i = 0; i < objects.length; i++) {
                try {
                    if(objects[i].name === 'Model') continue
                    const uid = getUID(objects[i])
                    for(let j = 0; j < i; j++) {
                        if(objectsJSON[i] === objectsJSON[j]) {
                            if(!idReplaceMap[uid.low]) idReplaceMap[uid.low] = {}
                            idReplaceMap[uid.low][uid.high] = getUID(objects[j])
                            break
                        }
                    }
                } catch(e) {}
            }

            objectsNode.children = objects.filter(o => {
                try {
                    const uid = getUID(o)
                    if(!idReplaceMap[uid.low]) return true
                    if(!idReplaceMap[uid.low][uid.high]) return true
                    return false
                } catch(e) {
                    return true
                }
            })

            const connections = parsed.children.filter(a => a.name === 'Connections')[0]
            if(!connections.children) throw new Error('Invalid FBX file')
            connections.children = connections.children.map(con => {
                const props = con.properties
                if(!props) return con
                const [type, from, to] = props
                if(type.type !== 'S' || type.value !== 'OO') return con
                if(from.type !== 'L') return con
                if(to.type !== 'L') return con
                const uid = from.value
                if(idReplaceMap[uid.low] && idReplaceMap[uid.low][uid.high]) {
                    from.value = idReplaceMap[uid.low][uid.high]
                }

                return con
            })
            console.timeEnd('deduplicate')
        }
        console.time('serialize')
        const serialized = await fbx.serialize(parsed)
        console.timeEnd('serialize')
        console.time('write')
        fs.writeFileSync(to, new Buffer(serialized.buffer))
        console.timeEnd('write')
        process.exit(0)
    } catch(e) {
        console.error(e)
        process.exit(1)
    }
    //await fbx.parse(buffer)
})()
