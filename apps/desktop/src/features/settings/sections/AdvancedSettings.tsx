import { IconLock } from '@tabler/icons-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { isCredentialName, SECRET_NAMES, SECRET_NAME_MAX_LENGTH, SECRET_VALUE_MAX_LENGTH, type SecretMetadata, type SecretName, type SecretResult } from '../../../../shared/credentials.ts'
import { GlassButton } from '../../../components/ui/glass.tsx'
import { SettingsGroup, SettingsRow } from './shared.tsx'

export function AdvancedSettings() {
  const id = useId()
  const [expanded, setExpanded] = useState(false)
  const [rows, setRows] = useState<SecretMetadata[] | null>(null)
  // Only metadata/control state lives in React. The draft exists solely in this DOM node.
  const [editing, setEditing] = useState<SecretName | null>(null)
  const [removing, setRemoving] = useState<SecretName | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const mounted = useRef(true)
  const generation = useRef(0)
  const inFlight = useRef(false)
  const input = useRef<HTMLInputElement | null>(null)
  const nameInput = useRef<HTMLInputElement | null>(null)
  const clearInput = useCallback(() => {
    if (input.current) input.current.value = ''
  }, [])
  const bindInput = useCallback((node: HTMLInputElement | null) => {
    // React invokes this before detaching an input, including Settings search/navigation.
    if (input.current !== node) clearInput()
    input.current = node
    node?.focus()
  }, [clearInput])
  useEffect(() => {
    mounted.current = true
    window.addEventListener('pagehide', clearInput)
    return () => {
      mounted.current = false
      generation.current++
      window.removeEventListener('pagehide', clearInput)
      clearInput()
    }
  }, [clearInput])

  const cancel = () => {
    clearInput()
    generation.current++
    setEditing(null)
    setRemoving(null)
    setMessage('')
  }
  const edit = (name: SecretName) => {
    cancel()
    setEditing(name)
    input.current?.focus()
  }
  const confirmRemove = (name: SecretName) => {
    cancel()
    setRemoving(name)
  }
  const current = (version: number) => mounted.current && generation.current === version

  const refresh = async () => {
    const version = ++generation.current
    setRows(null)
    setMessage('')
    try {
      const result = await window.heraldOS.credentials.list()
      if (!current(version)) return
      if (result.ok) setRows(result.data)
      else setMessage('Could not load credential status. Try again.')
    } catch {
      if (current(version)) setMessage('Could not load credential status. Try again.')
    }
  }

  const finish = async (pending: Promise<SecretResult<null>>, version: number, operation: 'save' | 'remove') => {
    try {
      const result = await pending
      if (!current(version)) return
      if (!result.ok) {
        setMessage(result.code === 'duplicate' ? 'This name already exists. Refresh status and use Update.' :
          result.code === 'not-found' ? 'This credential no longer exists. Refresh status and add it again.' :
          `Could not ${operation} credential. Try again.`)
        return
      }
      cancel()
      await refresh()
    } catch {
      if (current(version)) setMessage(`Could not ${operation} credential. Try again.`)
    } finally {
      inFlight.current = false
      if (mounted.current) setBusy(false)
    }
  }

  const remove = () => {
    if (!removing || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setMessage('')
    const version = ++generation.current
    try {
      void finish(window.heraldOS.credentials.remove(removing, true), version, 'remove')
    } catch {
      inFlight.current = false
      setBusy(false)
      setMessage('Could not remove credential. Try again.')
    }
  }

  const save = () => {
    if (!input.current || editing === null || inFlight.current) return
    const name = editing || nameInput.current?.value || ''
    let value = input.current.value
    clearInput()
    if (!isCredentialName(name)) {
      value = ''
      setMessage('Invalid credential name. Use the credential-purpose format below; runtime names are reserved.')
      return
    }
    if (editing === '' && (SECRET_NAMES.some(preset => preset === name) || rows?.some(row => row.name === name))) {
      value = ''
      setMessage('This name already exists. Use its existing Add or Update action.')
      return
    }
    if (!value.trim() || value.length > SECRET_VALUE_MAX_LENGTH || /[^\x20-\x7e]/.test(value)) {
      value = ''
      setMessage('Could not save credential. Enter a single-line ASCII value (up to 4096 characters).')
      return
    }
    inFlight.current = true
    setBusy(true)
    setMessage('')
    const version = ++generation.current
    try {
      const mode = editing === '' || (SECRET_NAMES.some(preset => preset === name) && !rows?.find(row => row.name === name)?.isConfigured) ? 'add' : 'update'
      const pending = window.heraldOS.credentials.save(name, value, mode)
      value = ''
      void finish(pending, version, 'save')
    } catch {
      inFlight.current = false
      setBusy(false)
      setMessage('Could not save credential. Try again.')
    } finally {
      value = ''
    }
  }

  const toggle = () => {
    cancel()
    setExpanded(!expanded)
    if (!expanded) void refresh()
    else setRows(null)
  }

  return (
    <SettingsGroup>
      <SettingsRow icon={<IconLock />} label="Advanced Settings" description="Provider credentials and GPT-Live." keywords="secret api key openai anthropic openrouter gemini xai groq"
        below={expanded && (
          <div id={id} className="flex flex-col gap-3">
            <p className="text-[12px] text-fg-3">Credentials are stored in the active Hermes profile’s .env (HERMES_HOME). Other profiles are not changed. Hermes may also reconcile credential-pool and existing configuration references. Reload or restart affected sessions yourself if needed; nothing restarts automatically. No provider calls are made to validate credentials.</p>
            {message && <p role="alert" className="text-[12px] text-danger">{message}</p>}
            <div className="flex gap-2">
              <GlassButton size="sm" disabled={busy || !rows} aria-label="Add Key" onClick={() => edit('')}>Add Key</GlassButton>
              <GlassButton size="sm" disabled={busy} aria-label="Refresh credential status" onClick={() => { cancel(); void refresh() }}>Refresh status</GlassButton>
            </div>
            {rows ? rows.map(row => (
              <div key={row.name} className="flex items-center justify-between gap-3 text-[12px]">
                <span className="font-mono">{row.name}</span>
                <span>{row.isConfigured ? 'Configured' : 'Not configured'}</span>
                <GlassButton size="sm" disabled={busy} aria-label={`${row.isConfigured ? 'Update' : 'Add'} ${row.name}`} onClick={() => edit(row.name)}>
                  {row.isConfigured ? 'Update' : 'Add'}
                </GlassButton>
                {row.isConfigured && <GlassButton size="sm" disabled={busy} variant="danger" aria-label={`Remove ${row.name}`} onClick={() => confirmRemove(row.name)}>Remove</GlassButton>}
              </div>
            )) : !message && <p role="status">Loading credential status…</p>}
            {editing !== null && (
              <form data-edit-ignore="" onSubmit={event => { event.preventDefault(); save() }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); cancel() } }} className="flex flex-col gap-2">
                {editing === '' && <>
                  <label htmlFor={`${id}-name`} className="text-[12px]">Credential name</label>
                  <input id={`${id}-name`} ref={nameInput} aria-label="Credential name" type="text" disabled={busy} autoComplete="off" spellCheck={false} maxLength={SECRET_NAME_MAX_LENGTH} placeholder="ACME_API_KEY" className="rounded-lg border border-line bg-black/15 px-3 py-2 font-mono text-[13px] text-fg" />
                  <p className="text-[12px] text-fg-3">Use uppercase ASCII letters, digits and single underscores, up to 128 characters. End with _API_KEY, _ACCESS_TOKEN, _AUTH_TOKEN, _CLIENT_SECRET or _SECRET_KEY. Runtime/control names are reserved.</p>
                </>}
                <label htmlFor={`${id}-secret`} className="text-[12px]">{editing ? `New value for ${editing}` : 'New credential value'}</label>
                <input id={`${id}-secret`} ref={bindInput} type="password" disabled={busy} autoComplete="new-password" spellCheck={false} maxLength={SECRET_VALUE_MAX_LENGTH} className="rounded-lg border border-line bg-black/15 px-3 py-2 text-[13px] text-fg" />
                <GlassButton size="sm" disabled={busy} type="submit" aria-label="Save credential">{busy ? 'Saving…' : 'Save'}</GlassButton>
                <GlassButton size="sm" type="button" aria-label="Cancel credential edit" onClick={cancel}>Cancel</GlassButton>
              </form>
            )}
            {removing && (
              <div role="alertdialog" aria-labelledby={`${id}-remove`} className="flex flex-col gap-2">
                <p id={`${id}-remove`} className="text-[12px]">Remove {removing} from the active profile and its Hermes credential references? Features using it may stop working.</p>
                <div className="flex gap-2">
                  <GlassButton size="sm" variant="ghost" aria-label="Cancel removal" onClick={cancel}>Cancel</GlassButton>
                  <GlassButton size="sm" disabled={busy} variant="danger" aria-label={`Confirm removal of ${removing}`} onClick={remove}>Confirm removal</GlassButton>
                </div>
              </div>
            )}
          </div>
        )}>
        <GlassButton size="sm" aria-label="Advanced Settings" aria-expanded={expanded} aria-controls={id} onClick={toggle}>
          {expanded ? 'Collapse' : 'Expand'}
        </GlassButton>
      </SettingsRow>
    </SettingsGroup>
  )
}
