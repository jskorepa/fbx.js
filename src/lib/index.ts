import * as zlib from 'zlib'

/**
 * Nothing FBX-specific about this class, but I do not want to collide with
 * future ES Stream, SimpleStream or anything else that might appear.
 * 
 * For now it only wraps ArrayBuffer to look like stream (read and it is gone)
 */
class FBXStream {
    private readonly view: DataView
    private pos: number

    constructor(data: ArrayBuffer | Uint8Array) {
        if(data instanceof ArrayBuffer)
            this.view = new DataView(data, 0, data.byteLength)
        else
            this.view = new DataView(data.buffer, data.byteOffset, data.byteLength)
        this.pos = 0
    }

    incr(n: number) {
        this.pos += n
        return this.pos - n
    }

    getUint8() {
        return this.view.getUint8(this.incr(1))
    }
    getInt8() {
        return this.view.getInt8(this.incr(1))
    }
    getUint16() {
        return this.view.getUint16(this.incr(2), true)
    }
    getInt16() {
        return this.view.getInt16(this.incr(2), true)
    }
    getUint32() {
        return this.view.getUint32(this.incr(4), true)
    }
    getInt32() {
        return this.view.getInt32(this.incr(4), true)
    }
    getFloat32() {
        return this.view.getFloat32(this.incr(4), true)
    }
    getFloat64() {
        return this.view.getFloat64(this.incr(8), true)
    }
    getString(n: number) {
        let str = ''
        for(let i = 0; i < n; i++) {
            str += String.fromCharCode(this.getUint8())
        }
        return str
    }
    getUint8Array(n: number) {
        const ret = new Uint8Array(n)
        for(let i = 0; i < n; i++) ret.set([this.getUint8()], i)
        return ret
    }
}

export type inflate = (bytes: Uint8Array) => Promise<Uint8Array>
const _inflate: inflate = (bytes) => new Promise((resolve, reject) => {
    const buffer = new Buffer(bytes)
    zlib.inflate(buffer, (err, res) => {
        if(err) {
            reject(err)
            return
        }
        resolve(res)
    })
})

export type Options = {
    inflate?: inflate,
}

type InternalOptions = {
    inflate: inflate,
}

export type FBXProperty =
    { type: 'Y', value: number }
    | { type: 'C', value: boolean }
    | { type: 'I', value: number }
    | { type: 'F', value: number }
    | { type: 'D', value: number }
    | { type: 'L', value: { high: number, low: number } }
    | { type: 'i', values: Array<number> }
    | { type: 'f', values: Array<number> }
    | { type: 'd', values: Array<number> }
    | { type: 'l', values: Array<{ high: number, low: number }> }
    | { type: 'R', value: Uint8Array }
    | { type: 'S', value: string }

export interface FBXNode {
    name: string,
    properties?: Array<FBXProperty>,
    children?: Array<FBXNode>,
}

// complete
const checkMagic = (stream: FBXStream) => {
    const magic = "Kaydara FBX Binary  "
    for(let i = 0; i < magic.length; i++) {
        if(stream.getUint8() !== magic.codePointAt(i)) return false
    }
    if(stream.getUint8() != 0x00) return false
    if(stream.getUint8() != 0x1A) return false
    if(stream.getUint8() != 0x00) return false
    return true
}
type readPropertyArray = (isType: (a: string) => boolean, stream: FBXStream, count: number) => FBXProperty
const readPropertyArray: readPropertyArray = (isType, stream, count) => {
    const impl = <T>(func: () => T): Array<T> => {
        const values = []
        for(let i = 0; i < count; i++) {
            values.push(func())
        }
        return values
    }
    if(isType('i')) {
        return { type: 'i', values: impl(() => stream.getInt32()) }
    } else if(isType('f')) {
        return { type: 'f', values: impl(() => stream.getFloat32()) }
    } else if(isType('d')) {
        return { type: 'd', values: impl(() => stream.getFloat64()) }
    } else if(isType('l')) {
        return { type: 'l', values: impl(() => ({
            low: stream.getUint32(),
            high: stream.getUint32(),
        })) }
    }
    throw new Error('Unknown property array type (this is bug in fbx.js)')
}

type propertyArrayByteLength = (isType: (a: string) => boolean, count: number) => number
const propertyArrayByteLength: propertyArrayByteLength = (isType, count) => {
    if(isType('y')) return count * 2
    if(isType('c')) return count
    if(isType('i')) return count * 4
    if(isType('f')) return count * 4
    if(isType('d')) return count * 8
    if(isType('l')) return count * 8
    throw new Error('Unknown property array type (this is bug in fbx.js)')
}

type readProperty = (stream: FBXStream, options: InternalOptions) => Promise<FBXProperty>
const readProperty: readProperty = async (stream, options) => {
    const type = stream.getUint8()
    const isType = (str: string) => type === str.charCodeAt(0)
    if(isType('S')) {
        const length = stream.getUint32()
        return { type: 'S', value: stream.getString(length) }
    } else if(isType('R')) {
        const length = stream.getUint32()
        return { type: 'R', value: stream.getUint8Array(length) }
    } else if(isType('Y')) {
         return { type: 'Y', value: stream.getInt16() }
    } else if(isType('C')) {
        return { type: 'C', value: !!(stream.getUint8()) }
    } else if(isType('I')) {
        return { type: 'I', value: stream.getInt32() }
    } else if(isType('F')) {
        return { type: 'F', value: stream.getFloat32() }
    } else if(isType('D')) {
        return { type: 'D', value: stream.getFloat64() }
    } else if(isType('L')) {
        return {
            type: 'L',
            value: {
                low: stream.getUint32(),
                high: stream.getUint32(),
            },
        }
    } else if(
        ['y', 'c', 'i', 'f', 'd', 'l']
        .map((a: string) => a.charCodeAt(0))
        .filter(a => a === type).length > 0
    ) {
        const arrayLength = stream.getUint32()
        const encoding = stream.getUint32()
        const compressedLength = stream.getUint32()
        if(encoding === 1) { // compressed
            const buffer = stream.getUint8Array(compressedLength)
            const inflated = await options.inflate(buffer)
            if(inflated.byteLength != propertyArrayByteLength(isType, arrayLength)) {
                console.error(inflated.byteLength, String.fromCharCode(type), arrayLength)
                throw new Error('Inflated length does not match with expected length')
            }
            return readPropertyArray(isType, new FBXStream(inflated), arrayLength)
        } else if(encoding === 0) {
            return readPropertyArray(isType, stream, arrayLength)
        } else {
            throw new Error('Unknown encoding ' + encoding)
        }
    }
    throw new Error('Unknown property type ' + type + ' ('+String.fromCodePoint(type)+')')
}

const isNodeNull = (node: FBXNode): boolean => {
    return !node.children && !node.properties && node.name.length === 0
}

type readNode = (stream: FBXStream, offset: number, options: InternalOptions) => Promise<{
    node: FBXNode,
    bytes: number
}>
const readNode: readNode = async (stream, offset, options) => {
    let bytes = 0

    const endOffset = stream.getUint32()
    const numProperties = stream.getUint32()
    const propertyListLength = stream.getUint32()
    const nameLength = stream.getUint8()
    const name = stream.getString(nameLength)
    bytes += 13 + nameLength

    const node: FBXNode = {
        name,
        properties: undefined,
        children: undefined,
    }

    for(let i = 0; i < numProperties; i++) {
        if(!node.properties) node.properties = []
        node.properties.push(await readProperty(stream, options))
    }
    bytes += propertyListLength

    while(offset + bytes < endOffset) {
        const child = await readNode(stream, offset + bytes, options)
        if(!node.children) node.children = []
        node.children.push(child.node)
        bytes += child.bytes
    }

    return {
        node,
        bytes,
    }
}

export type FBXDocument = {
    version: number,
    children: Array<FBXNode>,
}

export const parse = async (data: Uint8Array, _options: Options = {}): Promise<FBXDocument> => {
    const options = {
        inflate: _options.inflate || _inflate,
    }
    const stream = new FBXStream(data)
    if(!checkMagic(stream)) throw new Error('Not FBX file')
    const version = stream.getUint32()
    const maxVersion = 7400
    if(version > maxVersion) throw new Error(
            'Unsupported FBX version '+version
            +' latest supported version is '+maxVersion
        )
    
    let offset = 27 // magic: 21+2, version: 4
    const nodes: Array<FBXNode> = []
    do {
        const { node, bytes } = await readNode(stream, offset, options)
        offset += bytes
        if(isNodeNull(node)) break
        nodes.push(node)
    } while(true)
    return {
        version,
        children: nodes
    }
}

const propertyByteLength = (prop: FBXProperty): number => {
    if(prop.type === 'Y') {
        return 3
    } else if(prop.type === 'C') {
        return 2
    } else if(prop.type === 'I') {
        return 5
    } else if(prop.type === 'F') {
        return 5
    } else if(prop.type === 'D') {
        return 9
    } else if(prop.type === 'L') {
        return 9
    } else if(prop.type === 'R') {
        return 1 + 4 + prop.value.byteLength
    } else if(prop.type === 'S') {
        return 1 + 4 + prop.value.length
    } else if(prop.type === 'i') {
        return 13 + prop.values.length * 4
    } else if(prop.type === 'f') {
        return 13 + prop.values.length * 4
    } else if(prop.type === 'd') {
        return 13 + prop.values.length * 8
    } else if(prop.type === 'l') {
        return 13 + prop.values.length * 8
    }
    throw new Error('Unknown property type "' + (<FBXProperty>prop).type + '"')
}

const nodeByteLength = (node: FBXNode): number => {
    let length = 13 + node.name.length
    if(typeof node.properties === 'object') {
        length += node.properties.map(propertyByteLength).reduce((a,b) => a+b)
    }
    if(typeof node.children === 'object') {
        length += node.children.map(nodeByteLength).reduce((a,b) => a+b)
    }
    return length
}

const serializeProperty = (prop: FBXProperty, offset: number, view: DataView): number => {
    view.setUint8(offset, prop.type.charCodeAt(0))
    if(prop.type == 'Y') {
        view.setInt16(offset + 1, prop.value, true)
        return 3
    } else if(prop.type == 'C') {
        view.setUint8(offset + 1, prop.value ? 1 : 0)
        return 2
    } else if(prop.type == 'I') {
        view.setInt32(offset + 1, prop.value, true)
        return 5
    } else if(prop.type == 'F') {
        view.setFloat32(offset + 1, prop.value, true)
        return 5
    } else if(prop.type == 'D') {
        view.setFloat64(offset + 1, prop.value, true)
        return 9
    } else if(prop.type == 'L') {
        view.setInt32(offset + 1, prop.value.low, true)
        view.setInt32(offset + 5, prop.value.high, true)
        return 9
    } else if(prop.type == 'R') {
        view.setUint32(offset+1, prop.value.length, true)
        for(let i = 0; i < prop.value.length; i++) {
            view.setUint8(offset+5+i, prop.value[i])
        }
        return 1 + 4 + prop.value.length
    } else if(prop.type == 'S') {
        view.setUint32(offset+1, prop.value.length, true)
        for(let i = 0; i < prop.value.length; i++) {
            view.setUint8(offset+5+i, prop.value.codePointAt(i) || 0)
        }
        return 1 + 4 + prop.value.length
    } else {
        view.setUint32(offset+1, prop.values.length, true)
        view.setUint32(offset+5, 0, true) // encoding // TODO: support compression
        let compressedLength = 0
        if(prop.type == 'f') compressedLength = prop.values.length * 4
        else if(prop.type == 'd') compressedLength = prop.values.length * 8
        else if(prop.type == 'l') compressedLength = prop.values.length * 8
        else if(prop.type == 'i') compressedLength = prop.values.length * 4
        else throw new Error("Invalid property")
        view.setUint32(offset+9, compressedLength, true)

        let i = 0
        if(prop.type === 'l') for(const e of prop.values) {
            view.setUint32(offset + i*8 + 13, e.low, true)
            view.setUint32(offset + i*8 + 4 + 13, e.high, true)
            i++
        } else for(const e of prop.values) {
            if(prop.type === 'f') view.setFloat32(offset+i*4+13, e, true)
            else if(prop.type === 'd') view.setFloat64(offset+i*8+13, e, true)
            else if(prop.type === 'i') view.setInt32(offset+i*4+13, e, true)
            else throw new Error("Invalid property")
            i++
        }
        if(prop.type === 'l') return i*8 + 13
        if(prop.type === 'f') return i*4 + 13
        if(prop.type === 'd') return i*8 + 13
        if(prop.type === 'i') return i*4 + 13
        throw new Error('Invalid property')
    }
}

const serializeNode = (node: FBXNode, _offset: number, view: DataView): number => {
    let offset = _offset
    const { name, children, properties } = node
    if(name === '' && !children && !properties) {
        for(let i = 0; i < 13; i++) {
            view.setUint8(offset++, 0)
        }
        return 13
    }
    const propertyListLength = !properties ? 0 : properties.map(propertyByteLength).reduce((a,b) => a+b)
    const bytes = 13 + name.length + propertyListLength + (!children ? 0 : children.map(nodeByteLength).reduce((a,b) => a+b))

    const incr = (n: number) => {
        offset += n
        return offset - n
    }

    view.setUint32(incr(4), _offset + bytes, true)
    view.setUint32(incr(4), properties ? properties.length : 0, true)
    view.setUint32(incr(4), propertyListLength, true)
    view.setUint8(incr(1), name.length)
    for(let i = 0; i < name.length; i++) {
        view.setUint8(incr(1), name.charCodeAt(i))
    }
    let curOffset = 13 + name.length
    if(properties) for(const prop of properties) {
        curOffset += serializeProperty(prop, _offset + curOffset, view)
    }
    if(children) for(const child of children) {
        curOffset += serializeNode(child, _offset + curOffset, view)
    }

    if(curOffset != bytes) {
        console.error({curOffset, bytes, propertyListLength, children, properties, name})
        throw new Error('FAIL')
    }
    return bytes
}

export const serialize = async (doc: FBXDocument): Promise<Uint8Array> => {
    const { children, version } = doc
    const footer = [
        0xfa, 0xbc, 0xab, 0x09,
        0xd0, 0xc8, 0xd4, 0x66, 0xb1, 0x76, 0xfb, 0x83, 0x1c, 0xf7, 0x26, 0x7e, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0xe8, 0x1c, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf8, 0x5a, 0x8c, 0x6a,
        0xde, 0xf5, 0xd9, 0x7e, 0xec, 0xe9, 0x0c, 0xe3, 0x75, 0x8f, 0x29, 0x0b
    ]
    const byteLength = 27 // magic: 21+2, version: 4
        + children.map(nodeByteLength).reduce((a,b) => a+b)
        + 13
        + footer.length
    const buffer = new Uint8Array(byteLength)
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    const magic = "Kaydara FBX Binary  "
    for(let i = 0; i < magic.length; i++) {
        buffer[i] = magic.codePointAt(i) || 0
    }
    buffer[20] = 0x00
    buffer[21] = 0x1A
    buffer[22] = 0x00
    view.setUint32(23, version, true)

    let offset = 27
    for(const node of children) {
        offset += serializeNode(node, offset, view)
    }
    offset += serializeNode({name: ''}, offset, view)
    
    for(const byte of footer) {
        buffer[offset++] = byte
    }

    return buffer
}