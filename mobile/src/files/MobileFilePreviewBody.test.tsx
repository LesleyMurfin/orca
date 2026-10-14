import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Image: 'Image',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  Text: 'Text',
  View: 'View'
}))

vi.mock('../components/MobileHtmlPreview', () => ({
  MobileHtmlPreview: 'MobileHtmlPreview'
}))

vi.mock('./MobileFileMarkdownPreview', () => ({
  MobileFileMarkdownPreview: 'MobileFileMarkdownPreview'
}))

vi.mock('./MobileFileMediaPreview', () => ({
  MobileFileMediaPreview: 'MobileFileMediaPreview'
}))

vi.mock('./MobileFilePreviewEditableSource', () => ({
  MobileFilePreviewEditableSource: 'MobileFilePreviewEditableSource'
}))

vi.mock('./MobileFilePreviewSourceText', () => ({
  MobileFilePreviewSourceText: 'MobileFilePreviewSourceText'
}))

vi.mock('../theme/mobile-theme', () => ({
  colors: { textPrimary: '#fff', textSecondary: '#999' }
}))

vi.mock('./mobile-file-preview-styles', () => ({
  filePreviewStyles: {}
}))

import { MobileFilePreviewBody } from './MobileFilePreviewBody'

const baseOptions = {
  relativePath: 'docs/page.html',
  title: 'page.html',
  editable: false,
  draftContent: '',
  saveError: '',
  lineColumn: null,
  imageWidth: 0,
  imageHeight: 0,
  onDraftChange: () => {},
  onImageError: () => {},
  onRetry: null
}

describe('MobileFilePreviewBody', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => {
      renderer?.unmount()
    })
    renderer = null
  })

  it('routes non-editable html through MobileHtmlPreview with source fallback', () => {
    const html = '<!doctype html><html><body><h1>hi</h1></body></html>'
    act(() => {
      renderer = create(
        createElement(MobileFilePreviewBody, {
          ...baseOptions,
          preview: {
            status: 'ready',
            kind: 'html',
            content: html,
            truncated: false,
            byteLength: html.length
          }
        })
      )
    })

    const preview = renderer!.root.findByType('MobileHtmlPreview' as never)
    expect(preview.props.html).toBe(html)

    const source = preview.props.renderSource()
    expect(source.type).toBe('MobileFilePreviewSourceText')
    expect(source.props).toMatchObject({
      relativePath: 'docs/page.html',
      content: html,
      truncated: false,
      byteLength: html.length
    })
  })

  it('keeps editable html on EditablePreviewSource', () => {
    act(() => {
      renderer = create(
        createElement(MobileFilePreviewBody, {
          ...baseOptions,
          editable: true,
          draftContent: '<p>edit me</p>',
          preview: {
            status: 'ready',
            kind: 'html',
            content: '<p>edit me</p>',
            truncated: false,
            byteLength: 14
          }
        })
      )
    })

    expect(renderer!.root.findAllByType('MobileHtmlPreview' as never)).toHaveLength(0)
    expect(
      renderer!.root.findByType('MobileFilePreviewEditableSource' as never).props
    ).toMatchObject({
      title: 'page.html',
      draftContent: '<p>edit me</p>'
    })
  })
})
