import { describe, expect, it } from 'vitest'
import {
  FrameDecoder,
  HEADER_LENGTH,
  MAX_MESSAGE_SIZE,
  MessageType,
  encodeKeepAliveFrame,
  type DecodedFrame
} from './protocol'

describe('relay FrameDecoder', () => {
  it('reports an oversized frame after the header without buffering the full payload', () => {
    const errors: Error[] = []
    const frames: DecodedFrame[] = []
    const decoder = new FrameDecoder(
      (f) => frames.push(f),
      (err) => errors.push(err)
    )
    const oversizedLength = MAX_MESSAGE_SIZE + 1
    const header = Buffer.alloc(HEADER_LENGTH)
    header[0] = MessageType.Regular
    header.writeUInt32BE(1, 1)
    header.writeUInt32BE(0, 5)
    header.writeUInt32BE(oversizedLength, 9)

    decoder.feed(header)

    expect(frames).toHaveLength(0)
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain('discarded')

    decoder.feed(Buffer.concat([Buffer.alloc(oversizedLength), encodeKeepAliveFrame(2, 1)]))

    expect(frames).toHaveLength(1)
    expect(frames[0].type).toBe(MessageType.KeepAlive)
  })

  it('copies trailing partial-frame bytes after discarding an oversized payload chunk', () => {
    const errors: Error[] = []
    const frames: DecodedFrame[] = []
    const decoder = new FrameDecoder(
      (f) => frames.push(f),
      (err) => errors.push(err)
    )
    const oversizedLength = MAX_MESSAGE_SIZE + 1
    const header = Buffer.alloc(HEADER_LENGTH)
    header[0] = MessageType.Regular
    header.writeUInt32BE(1, 1)
    header.writeUInt32BE(0, 5)
    header.writeUInt32BE(oversizedLength, 9)
    const keepAlive = encodeKeepAliveFrame(2, 1)

    decoder.feed(header)

    const payloadWithTrailingHeaderPrefix = Buffer.concat([
      Buffer.alloc(oversizedLength),
      keepAlive.subarray(0, 5)
    ])
    decoder.feed(payloadWithTrailingHeaderPrefix)
    payloadWithTrailingHeaderPrefix.fill(0, oversizedLength)
    decoder.feed(keepAlive.subarray(5))

    expect(errors).toHaveLength(1)
    expect(frames).toHaveLength(1)
    expect(frames[0].type).toBe(MessageType.KeepAlive)
    expect(frames[0].id).toBe(2)
  })
})
