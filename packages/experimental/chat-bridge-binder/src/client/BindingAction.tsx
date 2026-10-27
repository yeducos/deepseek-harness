import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import {
  Button, IconChevronDownOutlineRegular, IconRefreshOutlineRegular, MenuSurface,
  useAnchoredPosition, useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  BindResult, BindingView, EndpointInfo, LeaveResult, RejoinResult, ResolveResult, RoomListResult, RoomSummary,
  SetEndpointFailureCode, SetEndpointRequest, SetEndpointResult, UnbindResult, WakeMode,
} from '../types.ts'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { NS } from './locales.ts'
import type { ChatBridgeBinderKey } from './locales.ts'
import css from './BindingAction.module.css'

/** Registration-side business face: runtime binding operations for one Session. */
export interface BindingActionInjected {
  /** Every binding this Host holds, without room credentials. */
  readonly list: () => Promise<readonly BindingView[]>
  /** Public rooms the configured chat-bridge service reports, without credentials. */
  readonly rooms: () => Promise<RoomListResult>
  /** Resolve an invite link, room id, or room cookie into a room the bind can use. */
  readonly resolve: (request: {
    readonly value: string
    readonly accessKey?: string
  }) => Promise<ResolveResult>
  /** Bind this Session to a room; the room handshake runs before the answer. */
  readonly bind: (request: {
    readonly sessionId: string
    readonly cookie: string
    readonly agentName?: string
    readonly accessKey?: string
    readonly wake: WakeMode
  }) => Promise<BindResult>
  /** Remove the bound member from its room while keeping the binding. */
  readonly leave: (request: { readonly sessionId: string }) => Promise<LeaveResult>
  /** Re-enter the room of a binding whose member left. */
  readonly rejoin: (request: {
    readonly sessionId: string
    readonly accessKey?: string
  }) => Promise<RejoinResult>
  /** Remove this Session's runtime binding. */
  readonly unbind: (sessionId: string) => Promise<UnbindResult>
  /** The chat-bridge service address this Host loaded from its configuration. */
  readonly endpoint: () => Promise<EndpointInfo>
  /** Persist a new service address into the profile patch; it applies after a restart. */
  readonly setEndpoint: (request: SetEndpointRequest) => Promise<SetEndpointResult>
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
  'invalid-value': 'error.invalid-value',
  'room-unknown': 'error.room-unknown',
  'room-private': 'error.room-private',
  'resolution-unsupported': 'error.resolution-unsupported',
  'not-bound': 'error.not-bound',
  'not-left': 'error.not-left',
} as const satisfies Record<string, ChatBridgeBinderKey>

/** Service-address refusal codes that carry their own localized copy. */
const ENDPOINT_FAILURE_COPY = {
  'invalid-url': 'error.endpoint.invalid-url',
  'profile-unavailable': 'error.endpoint.profile-unavailable',
  'row-missing': 'error.endpoint.row-missing',
  'write-failed': 'error.endpoint.write-failed',
} as const satisfies Record<SetEndpointFailureCode, ChatBridgeBinderKey>

/**
 * Session-header entry point for the chat-bridge binding of this Session.
 * Entry opens a small panel whose main body is the room list: pressing a room
 * enters it directly, while an invite link, a room id, or a raw cookie enter
 * through the secondary form. A bound Session shows its member name, its
 * status, and the leave, rejoin, and unbind actions.
 * @param props - runtime slot currency (the Session identity), the binding
 *   operations, and the namespace translator.
 * @returns the trigger and its popover panel.
 */
export function BindingAction({
  sessionId, list, rooms, resolve, bind, leave, rejoin, unbind, endpoint, setEndpoint, t,
}: BindingActionProps) {
  const [open, setOpen] = useState(false)
  const [binding, setBinding] = useState<BindingView | null | undefined>(undefined)
  const [roomRows, setRoomRows] = useState<readonly RoomSummary[] | undefined>(undefined)
  const [roomsWorking, setRoomsWorking] = useState(false)
  const [roomsFailed, setRoomsFailed] = useState(false)
  const [entryOpen, setEntryOpen] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [invite, setInvite] = useState('')
  const [accessKey, setAccessKey] = useState('')
  const [keyNeeded, setKeyNeeded] = useState(false)
  const [name, setName] = useState('')
  const [wake, setWake] = useState<WakeMode>('idle-only')
  const [rejoinKey, setRejoinKey] = useState('')
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [endpointOpen, setEndpointOpen] = useState(false)
  const [endpointUrl, setEndpointUrl] = useState('')
  const [endpointLoaded, setEndpointLoaded] = useState(false)
  const [endpointWorking, setEndpointWorking] = useState(false)
  const [endpointError, setEndpointError] = useState<string | undefined>(undefined)
  const [endpointSaved, setEndpointSaved] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const inviteRef = useRef<HTMLInputElement>(null)

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

  // An unbound panel reads the room list as soon as the Session is known to have no binding.
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

  // The service address is read whenever the panel opens, so the collapsed section already holds the loaded value.
  useEffect(() => {
    if (!open) return
    let current = true
    void endpoint().then(
      (value) => {
        if (current) {
          setEndpointUrl(value.url)
          setEndpointLoaded(true)
        }
      },
      () => {
        if (current) {
          setEndpointError(t('error.generic'))
          setEndpointLoaded(true)
        }
      },
    )
    return () => { current = false }
    // `endpoint` is an injected operation fixed for the plugin lifetime; `t` rebinds only with the locale.
  }, [open, endpoint, t])

  const menuPosition = useAnchoredPosition({
    open, anchorRef: rootRef, panelRef: menuRef, gap: MENU_GAP, margin: VIEWPORT_MARGIN,
  })
  useDismissOnOutsidePointer(rootRef, open, setOpen, menuRef)

  // The secondary form takes focus only once the user asks for it; the room list stays primary.
  useEffect(() => {
    if (open && binding === null && entryOpen) inviteRef.current?.focus()
  }, [open, binding, entryOpen])

  /** Bind with an already-resolved credential; the caller owns the working and error state. */
  const place = async (roomCookie: string, key: string | undefined): Promise<void> => {
    const trimmedName = name.trim()
    const result = await bind({
      sessionId,
      cookie: roomCookie,
      ...(trimmedName === '' ? {} : { agentName: trimmedName }),
      ...(key === undefined ? {} : { accessKey: key }),
      wake,
    })
    if (!result.ok) {
      if (result.code === 'room-rejected') setKeyNeeded(true)
      setError(t(FAILURE_COPY[result.code]))
      return
    }
    setBinding(result.binding)
    setInvite('')
    setAccessKey('')
    setKeyNeeded(false)
    setName('')
    setEntryOpen(false)
    setWake(result.binding.wake)
  }

  /** Enter a listed room directly; the resolver turns its room id into the credential. */
  const enter = async (roomId: string): Promise<void> => {
    setWorking(true)
    setError(undefined)
    try {
      const resolved = await resolve({ value: roomId })
      if (!resolved.ok) {
        // A listed room that turns out private asks for its key inline.
        if (resolved.code === 'room-private') {
          setKeyNeeded(true)
          setEntryOpen(true)
        }
        setError(t(FAILURE_COPY[resolved.code]))
        return
      }
      await place(resolved.room.cookie, resolved.room.accessKey)
    } catch {
      setError(t('error.generic'))
    } finally {
      setWorking(false)
    }
  }

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (working) return
    const value = invite.trim()
    if (value === '') {
      setError(t('error.invalid-value'))
      return
    }
    setWorking(true)
    setError(undefined)
    try {
      const typedKey = accessKey.trim()
      const resolved = await resolve({
        value,
        ...(typedKey === '' ? {} : { accessKey: typedKey }),
      })
      if (!resolved.ok) {
        if (resolved.code === 'room-private') setKeyNeeded(true)
        setError(t(FAILURE_COPY[resolved.code]))
        return
      }
      // A key embedded in the invite link wins over an empty field; an explicit field wins otherwise.
      await place(resolved.room.cookie, resolved.room.accessKey ?? (typedKey === '' ? undefined : typedKey))
    } catch {
      setError(t('error.generic'))
    } finally {
      setWorking(false)
    }
  }

  const leaveBinding = async (): Promise<void> => {
    setWorking(true)
    setError(undefined)
    try {
      const result = await leave({ sessionId })
      if (!result.ok) {
        setError(t(FAILURE_COPY[result.code]))
        return
      }
      await read()
    } catch {
      setError(t('error.generic'))
    } finally {
      setWorking(false)
    }
  }

  const rejoinBinding = async (): Promise<void> => {
    setWorking(true)
    setError(undefined)
    try {
      const typedKey = rejoinKey.trim()
      const result = await rejoin({
        sessionId,
        ...(typedKey === '' ? {} : { accessKey: typedKey }),
      })
      if (!result.ok) {
        setError(t(FAILURE_COPY[result.code]))
        return
      }
      setBinding(result.binding)
      setRejoinKey('')
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
      // The stored name memory survives, so the next bind rejoins under the same member name.
      setBinding(null)
      setEntryOpen(false)
    } catch {
      setError(t('error.generic'))
    } finally {
      setWorking(false)
    }
  }

  /** Persist the typed service address into the profile patch; it applies on the next start. */
  const saveEndpoint = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (endpointWorking) return
    setEndpointWorking(true)
    setEndpointSaved(false)
    setEndpointError(undefined)
    try {
      const result = await setEndpoint({ url: endpointUrl.trim() })
      if (!result.ok) {
        setEndpointError(t(ENDPOINT_FAILURE_COPY[result.code]))
        return
      }
      setEndpointUrl(result.url)
      setEndpointSaved(true)
    } catch {
      setEndpointError(t('error.generic'))
    } finally {
      setEndpointWorking(false)
    }
  }

  /** Ask the browser to open a room page in a new tab. */
  const openRoom = (url: string): void => {
    window.open(url, '_blank', 'noopener,noreferrer')
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
    : binding.roomName === undefined
      ? t('trigger.boundUnnamed', { name: binding.agentName })
      : t('trigger.bound', { room: binding.roomName, name: binding.agentName })

  const statusKey = binding === null || binding === undefined
    ? 'status.active'
    : binding.status === 'left'
      ? 'status.left'
      : binding.status === 'active' ? 'status.active' : 'status.stopped'

  const identity = binding === undefined
    ? t('working')
    : binding === null ? t('status.unbound') : t('boundAs', { name: binding.agentName })

  /** One chevron rotated by its section's open state. */
  const chevron = (expanded: boolean): ReactElement => (
    <IconChevronDownOutlineRegular
      size={12}
      className={expanded ? `${css.chevron} ${css.chevronOpen}` : css.chevron}
    />
  )

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
            <div className={css.header}>
              <div className={css.title} title={t('description')}>
                {binding === null || binding === undefined ? t('title') : t('title.bound')}
              </div>
              <div className={css.identity}>{identity}</div>
            </div>
            {error !== undefined ? <div className={css.error} role="alert">{error}</div> : null}
            {binding === undefined
              ? null
              : binding === null
                ? (
                  <>
                    <section className={css.rooms}>
                      <div className={css.roomsHeader}>
                        <span className={css.sectionLabel}>{t('rooms')}</span>
                        <button
                          type="button"
                          className={css.iconButton}
                          aria-label={t('rooms.refresh')}
                          title={t('rooms.refresh')}
                          disabled={roomsWorking}
                          onClick={() => { void loadRooms() }}
                        >
                          <IconRefreshOutlineRegular size={13} />
                        </button>
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
                                  <li key={room.roomId}>
                                    <button
                                      type="button"
                                      className={css.roomRow}
                                      title={room.roomId}
                                      disabled={working}
                                      onClick={() => { void enter(room.roomId) }}
                                    >
                                      <span className={css.roomName}>{room.name}</span>
                                      <span className={css.roomMeta}>
                                        {t('rooms.members', { count: room.members })}
                                      </span>
                                      <span className={css.roomEnter} aria-hidden="true">{t('rooms.enter')}</span>
                                    </button>
                                  </li>
                                ))}
                              </ul>
                            )}
                    </section>
                    <button
                      type="button"
                      className={css.entryToggle}
                      aria-expanded={entryOpen}
                      onClick={() => { setEntryOpen(current => !current) }}
                    >
                      {t('entry.toggle')}
                      {chevron(entryOpen)}
                    </button>
                    {entryOpen
                      ? (
                        <form className={css.form} onSubmit={(event) => { void submit(event) }}>
                          <label className={css.field}>
                            <span className={css.fieldLabel}>{t('entry.label')}</span>
                            <input
                              ref={inviteRef}
                              className={css.input}
                              type="text"
                              autoComplete="off"
                              spellCheck={false}
                              placeholder={t('invitePlaceholder')}
                              value={invite}
                              onChange={(event) => { setInvite(event.target.value) }}
                            />
                          </label>
                          {keyNeeded
                            ? (
                              <label className={css.field}>
                                <span className={css.fieldLabel}>{t('accessKey')}</span>
                                <input
                                  className={css.input}
                                  type="password"
                                  autoComplete="off"
                                  spellCheck={false}
                                  placeholder={t('accessKeyPlaceholder')}
                                  value={accessKey}
                                  onChange={(event) => { setAccessKey(event.target.value) }}
                                />
                              </label>
                            )
                            : null}
                          <button
                            type="button"
                            className={css.advancedToggle}
                            aria-expanded={advanced}
                            onClick={() => { setAdvanced(current => !current) }}
                          >
                            {t('advanced')}
                            {chevron(advanced)}
                          </button>
                          {advanced
                            ? (
                              <div className={css.advanced}>
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
                              </div>
                            )
                            : null}
                          <div className={css.footer}>
                            <Button
                              type="submit"
                              variant="primary"
                              size="sm"
                              disabled={working}
                            >
                              {working ? t('working') : t('bind')}
                            </Button>
                          </div>
                        </form>
                      )
                      : null}
                  </>
                )
                : (
                  <div className={css.form}>
                    <div className={css.metaLine}>
                      <span>{t(statusKey)}</span>
                      <span aria-hidden="true">·</span>
                      <span>{t(binding.wake === 'always' ? 'wake.always' : 'wake.idle-only')}</span>
                      {binding.source === 'declared'
                        ? (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>{t('source.declared')}</span>
                          </>
                        )
                        : null}
                    </div>
                    {binding.status === 'left'
                      ? (
                        <label className={css.field}>
                          <span className={css.fieldLabel}>{t('accessKey')}</span>
                          <input
                            className={css.input}
                            type="password"
                            autoComplete="off"
                            spellCheck={false}
                            placeholder={t('accessKeyPlaceholder')}
                            value={rejoinKey}
                            onChange={(event) => { setRejoinKey(event.target.value) }}
                          />
                          <span className={css.hint}>{t('rejoin.hint')}</span>
                        </label>
                      )
                      : null}
                    <div className={css.footer}>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={working}
                        onClick={() => { openRoom(binding.roomUrl) }}
                      >
                        {t('openRoom')}
                      </Button>
                      {binding.status === 'left'
                        ? (
                          <Button
                            type="button"
                            variant="primary"
                            size="sm"
                            disabled={working}
                            onClick={() => { void rejoinBinding() }}
                          >
                            {working ? t('working') : t('rejoin')}
                          </Button>
                        )
                        : (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={working}
                            onClick={() => { void leaveBinding() }}
                          >
                            {working ? t('working') : t('leave')}
                          </Button>
                        )}
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
                  </div>
                )}
            <section className={css.endpoint}>
              <button
                type="button"
                className={css.entryToggle}
                aria-expanded={endpointOpen}
                onClick={() => {
                  setEndpointOpen(current => !current)
                  setEndpointSaved(false)
                }}
              >
                {t('endpoint.toggle')}
                {chevron(endpointOpen)}
              </button>
              {endpointOpen
                ? (
                  <form className={css.form} onSubmit={(event) => { void saveEndpoint(event) }}>
                    <label className={css.field}>
                      <span className={css.fieldLabel}>{t('endpoint.label')}</span>
                      <input
                        className={css.input}
                        type="url"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder={t('endpoint.placeholder')}
                        value={endpointUrl}
                        onChange={(event) => {
                          setEndpointUrl(event.target.value)
                          setEndpointSaved(false)
                          setEndpointError(undefined)
                        }}
                      />
                      <span className={css.hint}>{t('endpoint.hint')}</span>
                    </label>
                    {endpointError !== undefined ? <div className={css.error} role="alert">{endpointError}</div> : null}
                    {endpointSaved ? <div className={css.hint} role="status">{t('endpoint.saved')}</div> : null}
                    <div className={css.footer}>
                      <Button
                        type="submit"
                        variant="primary"
                        size="sm"
                        disabled={endpointWorking || !endpointLoaded}
                      >
                        {endpointWorking ? t('working') : t('endpoint.save')}
                      </Button>
                    </div>
                  </form>
                )
                : null}
            </section>
          </MenuSurface>,
          document.body,
        )
        : null}
    </div>
  )
}
