// Binary frame decoding: [u32 LE header length][JSON header][8-byte aligned buffers].

const TYPED = {
  uint8: Uint8Array,
  uint16: Uint16Array,
  uint32: Uint32Array,
  int32: Int32Array,
  float32: Float32Array,
  float64: Float64Array,
};

/**
 * @param {ArrayBuffer} buffer
 * @param {number} [byteOffset] offset of the frame inside `buffer`
 * @returns {{header: any, arrays: ArrayBufferView[]}}
 */
export function decodeFrame(buffer, byteOffset = 0) {
  const view = new DataView(buffer, byteOffset);
  const n = view.getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, byteOffset + 4, n)));
  const arrays = header.buffers.map((spec) => {
    const T = TYPED[spec.dtype];
    if (!T) throw new Error(`unsupported dtype ${spec.dtype}`);
    const offset = byteOffset + spec.offset;
    const length = spec.nbytes / T.BYTES_PER_ELEMENT;
    if (offset % T.BYTES_PER_ELEMENT === 0) return new T(buffer, offset, length);
    return new T(buffer.slice(offset, offset + spec.nbytes));
  });
  return { header, arrays };
}
