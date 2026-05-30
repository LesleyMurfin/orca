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
})
