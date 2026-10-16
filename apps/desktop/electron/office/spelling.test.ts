import { app, BrowserWindow, Menu, type WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { registerSpellingMenus, spellingMenu } from './spelling.ts'

// Only Electron's event/menu boundary is replaced; menu construction and the
// registered callbacks still run from spelling.ts.
vi.mock('electron', () => ({
  app: { on: vi.fn(), getPreferredSystemLanguages: () => ['en-US'], getLocale: () => 'en-US' },
  BrowserWindow: { fromWebContents: vi.fn() },
  Menu: { buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })) }
}))

const editFlags = { canCut: true, canCopy: true, canPaste: true, canUndo: true, canRedo: true, canDelete: true, canSelectAll: true, canEditRichly: true }

function params(misspelledWord: string, dictionarySuggestions: string[]): Electron.ContextMenuParams {
  return { misspelledWord, dictionarySuggestions, isEditable: true, spellcheckEnabled: true, editFlags } as unknown as Electron.ContextMenuParams
}

describe('spellingMenu', () => {
  it('offers the suggestions for a misspelled word, then Add to Dictionary and editing', () => {
    const contents = { replaceMisspelling: vi.fn(), session: { addWordToSpellCheckerDictionary: vi.fn() } }
    const items = spellingMenu(contents as unknown as WebContents, params('recieve', ['receive', 'relieve']))

    expect(items.map((item) => item.role ?? item.label ?? item.type)).toEqual(['receive', 'relieve', 'Add to Dictionary', 'separator', 'cut', 'copy', 'paste', 'separator', 'selectAll'])
    items[0].click?.({} as never, undefined, {} as never)
    items[2].click?.({} as never, undefined, {} as never)
    expect(contents.replaceMisspelling).toHaveBeenCalledWith('receive')
    expect(contents.session.addWordToSpellCheckerDictionary).toHaveBeenCalledWith('recieve')
  })

  it('says when there are no guesses, and is only editing for a word spelled right', () => {
    const contents = {} as WebContents

    expect(spellingMenu(contents, params('qwzx', []))[0]).toEqual({ label: 'No Guesses Found', enabled: false })
    expect(spellingMenu(contents, params('', [])).map((item) => item.role ?? item.type)).toEqual(['cut', 'copy', 'paste', 'separator', 'selectAll'])
  })

  it("names every item in Herald's language, the editing ones too", () => {
    const contents = {} as WebContents

    expect(spellingMenu(contents, params('', [])).map((item) => item.label ?? item.type)).toEqual(['Cut', 'Copy', 'Paste', 'separator', 'Select All'])
    expect(spellingMenu(contents, params('qwzx', []), 'zh-CN').map((item) => item.label ?? item.type)).toEqual(['没有拼写建议', '添加到词典', 'separator', '剪切', '复制', '粘贴', 'separator', '全选'])
  })
})

// Exercise the registration boundary with event callbacks, not an Electron app.
describe('registerSpellingMenus', () => {
  it('opens a menu only for editable, spellchecked contents and uses its owning window', () => {
    const contents = { on: vi.fn() }
    registerSpellingMenus()
    expect(app.on).toHaveBeenCalledWith('web-contents-created', expect.any(Function))
    const created = vi.mocked(app.on).mock.calls[0][1] as (event: unknown, contents: WebContents) => void
    created({}, contents as unknown as WebContents)
    expect(contents.on).toHaveBeenCalledWith('context-menu', expect.any(Function))
    const contextMenu = contents.on.mock.calls[0][1] as (event: unknown, params: Electron.ContextMenuParams) => void
    const editable = params('recieve', ['receive'])

    contextMenu({}, { ...editable, isEditable: false })
    contextMenu({}, { ...editable, spellcheckEnabled: false })
    expect(Menu.buildFromTemplate).not.toHaveBeenCalled()
    expect(BrowserWindow.fromWebContents).not.toHaveBeenCalled()

    const owner = {} as BrowserWindow
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValueOnce(owner).mockReturnValueOnce(null)
    contextMenu({}, editable)
    expect(Menu.buildFromTemplate).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ label: 'receive', click: expect.any(Function) })]))
    expect(BrowserWindow.fromWebContents).toHaveBeenCalledWith(contents)
    const menu = vi.mocked(Menu.buildFromTemplate).mock.results[0].value
    expect(menu.popup).toHaveBeenCalledWith({ window: owner })

    contextMenu({}, editable)
    const detachedMenu = vi.mocked(Menu.buildFromTemplate).mock.results[1].value
    expect(detachedMenu.popup).toHaveBeenCalledWith({ window: undefined })
    expect(Menu.buildFromTemplate).toHaveBeenCalledTimes(2)
  })
})
