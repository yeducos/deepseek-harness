import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import {
  Button, MenuSurface, useAnchoredPosition, useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  BindResult, BindingView, RoomListResult, RoomSummary, UnbindResult, WakeMode,
} from '../types.ts'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { NS } from './locales.ts'
import css from './BindingAction.module.css'

/** Registration-side business face: runtime binding operations for one Session. */
export interface BindingActionInjected {
  /** Every binding this Host holds, without room credentials. */
  readonly list: () => Promise<readonly BindingView[]>
  /** Public rooms the configured chat-bridge service reports, without credentials. */
  readonly rooms: () => Promise<RoomListResult>
  /** Bind this Session to a room; the room handshake runs before the answer. */
  readonly bind: (request: {
    readonly sessionId: string
    readonly cookie: string
    readonly agentName?: string
    readonly wake: WakeMode
  }) => Promise<BindResult>
  /** Remove this Session's runtime binding. */
  readonly unbind: (sessionId: string) => Promise<UnbindResult>
}

/** Full props for the session-header chat-bridge action. */
export type BindingActionProps =
  PropsRuntime<'conversation.session.header.actions'>
  & PropsLocale<typeof NS>
  & InjectFace<BindingActionInjected>

/** Distance between the trigger's bottom edge and the popover. */
const MENU_GAP = 5

/** Minimum gap kept between the popover and the viewport edges. */
const VIEWPORT_MARGIN = 12

/** Unplaced popover: hidden but laid out so the first placement measures real dimensions. */
const MEASURE_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 }

/** Refusal codes that carry their own localized copy. */
const FAILURE_COPY = {
  'session-unknown': 'error.session-unknown',
  'invalid-cookie': 'error.invalid-cookie',
  'invalid-name': 'error.invalid-name',
  'declared-binding': 'error.declared-binding',
  'room-unreachable': 'error.room-unreachable',
  'room-rejected': 'error.room-rejected',
} as const

/**
 * Session-header entry point for the chat-bridge binding of this Session.
 * Entry opens a small form that binds the Session to a room without touching
 * cordis.yml or reloading; a bound Session shows its room and can unbind.
 * @param props - runtime slot currency (the Session identity), the binding
 *   operations, and the namespace translator.
 * @returns the trigger and its popover form.
 */
export function BindingAction({ sessionId, list, rooms, bind, unbind, t }: BindingActionProps) {
  const [open, setOpen] = useState(false)
  const [binding, setBinding] = useState<BindingView | null | undefined>(undefined)
  const [roomRows, setRoomRows] = useState<readonly RoomSummary[] | undefined>(undefined)
  const [roomsWorking, setRoomsWorking] = useState(false)
  const [roomsFailed, setRoomsFailed] = useState(false)
  const [cookie, setCookie] = useState('')
  const [name, setName] = useState('')
  const [wake, setWake] = useState<WakeMode>('idle-only')
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const cookieRef = useRef<HTMLInputElement>(null)

  const adopt = (rows: readonly BindingView[]): void => {
    setBinding(rows.find(row => row.sessionId === sessionId) ?? null)
  }

  const fail = (): void => {
    setError(t('error.generic'))
    // An unreadable first load still opens the form; a failed refresh keeps the known binding.
    setBinding(current => current === undefined ? null : current)
  }

  const read = (): Promise<void> => list().then(adopt, fail)

  const loadRooms = async (): Promise<void> => {
    setRoomsWorking(true)
    setRoomsFailed(false)
    try {
      const result = await rooms()
      if (!result.ok) {
        setRoomsFailed(true)
        return
      }
      setRoomRows(result.rooms)
    } catch {
      setRoomsFailed(true)
    } finally {
      setRoomsWorking(false)
    }
  }

  // An unbound form reads the room list as soon as the Session is known to have no binding.
  useEffect(() => {
    if (!open || binding !== null) return
    void loadRooms()
    // `rooms` is an injected operation fixed for the plugin lifetime; unbinding re-enters the form.
  }, [open, binding, rooms])

  useEffect(() => {
    let current = true
    void list().then((rows) => { if (current) adopt(rows) }, () => { if (current) fail() })
    return () => { current = false }
    // `list` is an injected operation fixed for the plugin lifetime; the Session identity rebinds reads.
  }, [sessionId, list])

  const menuPosition = useAnchoredPosition({
    open, anchorRef: rootRef, panelRef: menuRef, gap: MENU_GAP, margin: VIEWPORT_MARGIN,
  })
  useDismissOnOutsidePointer(rootRef, open, setOpen, menuRef)

  // A freshly opened form starts at the first field; a bound Session needs no input.
  useEffect(() => {
    if (open && binding === null) cookieRef.current?.focus()
  }, [open, binding])

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (working) return
    setWorking(true)
    setError(undefined)
    try {
      const trimmedName = name.trim()
      const result = await bind({
        sessionId,
        cookie: cookie.trim(),
        ...(trimmedName === '' ? {} : { agentName: trimmedName }),
        wake,
      })
      if (!result.ok) {
        setError(t(FAILURE_COPY[result.code]))
        return
      }
      setBinding(result.binding)
      setCookie('')
      setName('')
      setWake(result.binding.wake)
    } catch {
      setError(t('error.generic'))
    } finally {
      setWorking(false)
    }
  }

  const remove = async (): Promise<void> => {
    setWorking(true)
    setError(undefined)
    try {
      const result = await unbind(sessionId)
      if (!result.ok) {
        setError(t(FAILURE_COPY[result.code]))
        return
      }
      setBinding(null)
    } catch {
      setError(t('error.generic'))
    } finally {
      setWorking(false)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!open) return
    if (event.key !== 'Escape') return
    event.preventDefault()
    setOpen(false)
    triggerRef.current?.focus()
  }

  const label = binding === null || binding === undefined
    ? t('trigger')
    : t('trigger.bound', { name: binding.agentName })

  return (
    <div ref={rootRef} onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className={binding !== null && binding !== undefined ? `${css.trigger} ${css.triggerBound}` : css.trigger}
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => { setOpen(current => !current); if (!open) void read() }}
      >
        <span className={css.triggerLabel}>{label}</span>
      </button>
      {open
        ? createPortal(
          <MenuSurface ref={menuRef} className={css.menu} style={menuPosition ?? MEASURE_STYLE}>
            <div className={css.title}>{t('title')}</div>
            {binding === undefined
              ? <div className={css.hint}>{t('working')}</div>
              : binding === null
                ? (
                  <form className={css.form} onSubmit={(event) => { void submit(event) }}>
                    <p className={css.hint}>{t('description')}</p>
                    <section className={css.rooms}>
                      <div className={css.roomsHeader}>
                        <span className={css.fieldLabel}>{t('rooms')}</span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={roomsWorking}
                          onClick={() => { void loadRooms() }}
                        >
                          {roomsWorking ? t('working') : t('rooms.refresh')}
                        </Button>
                      </div>
                      {roomsFailed
                        ? <div className={css.roomsNotice}>{t('rooms.failed')}</div>
                        : roomRows === undefined
                          ? <div className={css.roomsNotice}>{t('working')}</div>
                          : roomRows.length === 0
                            ? <div className={css.roomsNotice}>{t('rooms.empty')}</div>
                            : (
                              <ul className={css.roomList}>
                                {roomRows.map(room => (
                                  <li key={room.roomId} className={css.roomRow}>
                                    <span className={css.roomName}>{room.name}</span>
                                    <span className={css.roomMeta}>
                                      {room.roomId} · {t('rooms.members', { count: room.members })}
                                      {' · '}{t('rooms.messages', { count: room.messages })}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            )}
                      <p className={css.hint}>{t('rooms.hint')}</p>
                    </section>
                    <label className={css.field}>
                      <span className={css.fieldLabel}>{t('cookie')}</span>
                      <input
                        ref={cookieRef}
                        className={css.input}
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder={t('cookiePlaceholder')}
                        value={cookie}
                        onChange={(event) => { setCookie(event.target.value) }}
                      />
                    </label>
                    <label className={css.field}>
                      <span className={css.fieldLabel}>{t('name')}</span>
                      <input
                        className={css.input}
                        type="text"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder={t('namePlaceholder')}
                        value={name}
                        onChange={(event) => { setName(event.target.value) }}
                      />
                    </label>
                    <label className={css.field}>
                      <span className={css.fieldLabel}>{t('wake')}</span>
                      <select
                        className={css.input}
                        value={wake}
                        onChange={(event) => {
                          setWake(event.target.value === 'always' ? 'always' : 'idle-only')
                        }}
                      >
                        <option value="idle-only">{t('wake.idle-only')}</option>
                        <option value="always">{t('wake.always')}</option>
                      </select>
                      <span className={css.hint}>
                        {t(wake === 'always' ? 'wake.always.hint' : 'wake.idle-only.hint')}
                      </span>
                    </label>
                    {error !== undefined ? <div className={css.error} role="alert">{error}</div> : null}
                    <Button type="submit" variant="primary" size="sm" disabled={working || cookie.trim() === ''}>
                      {working ? t('working') : t('bind')}
                    </Button>
                  </form>
                )
                : (
                  <div className={css.form}>
                    <div className={css.boundName}>{t('boundAs', { name: binding.agentName })}</div>
                    <dl className={css.facts}>
                      <div className={css.fact}>
                        <dt>{t('wake')}</dt>
                        <dd>{t(binding.wake === 'always' ? 'wake.always' : 'wake.idle-only')}</dd>
                      </div>
                      <div className={css.fact}>
                        <dt>{t('source')}</dt>
                        <dd>{t(binding.source === 'declared' ? 'source.declared' : 'source.runtime')}</dd>
                      </div>
                      <div className={css.fact}>
                        <dt>{t('status')}</dt>
                        <dd>{t(binding.status === 'active' ? 'status.active' : 'status.stopped')}</dd>
                      </div>
                    </dl>
                    {error !== undefined ? <div className={css.error} role="alert">{error}</div> : null}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={working}
                      onClick={() => { void remove() }}
                    >
                      {working ? t('working') : t('unbind')}
                    </Button>
                  </div>
                )}
          </MenuSurface>,
          document.body,
        )
        : null}
    </div>
  )
}
