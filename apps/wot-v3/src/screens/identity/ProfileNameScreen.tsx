// The own name and picture (Trust 6b, profile@1): one field, prefilled with the profile's name, and
// the picture above it (chosen from a file, cropped and scaled, lib/avatar.ts); saving draws the next
// profile revision, which the library delivers to every contact the profile class is on for, by
// default the trusted ones (2760, 6455). Others keep the name from the card they scanned. The profile
// body is replaced whole, so an unchanged picture is sent again with a new name. A page in the
// content column, "‹ Profile" on the desktop (handover desktop frames).
import { useRef, useState } from 'react'
import { usePort, useProfile } from '../../hooks'
import { useI18n } from '../../i18n'
import { avatarFromFile } from '../../lib/avatar'
import { Button } from '../../ui/primitives'
import { Callout, CameraIcon, Field, FlowPage, PersonAvatar, PrimaryAction } from '../../ui/components'

/** the library's bound on a profile name (lib PROFILE_LIMITS.name) */
export const NAME_MAX = 64

export function ProfileNameScreen({ onBack, toAvatar = avatarFromFile }: { onBack: () => void; toAvatar?: (file: Blob) => Promise<string> }) {
  const { t } = useI18n()
  const x = t.profileName
  const port = usePort()
  const profile = useProfile()
  const current = profile.status === 'ready' ? (profile.value.name ?? '') : ''
  const currentImage = profile.status === 'ready' ? profile.value.image : null
  const [value, setValue] = useState<string | null>(null)
  // undefined: unchanged; null: removed; a string: the new picture
  const [image, setImage] = useState<string | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<'save' | 'image' | false>(false)
  const file = useRef<HTMLInputElement | null>(null)
  const shown = value ?? current
  const name = shown.trim()
  const shownImage = image === undefined ? currentImage : image
  const imageChanged = image !== undefined && image !== currentImage
  const ready = name.length > 0 && (name !== current.trim() || imageChanged) && !busy
  const pick = async (f: File | undefined) => {
    if (!f) return
    setFailed(false)
    try {
      setImage(await toAvatar(f))
    } catch {
      setFailed('image')
    }
  }
  const save = async () => {
    if (!ready) return
    setBusy(true)
    setFailed(false)
    try {
      const r = await port.trust.setProfile(shownImage ? { name, image: shownImage } : { name }).done
      if (r.ok) onBack()
      else setFailed('save')
    } finally {
      setBusy(false)
    }
  }
  return (
    <FlowPage title={x.title} onBack={onBack} footer={<PrimaryAction label={x.save} onClick={() => void save()} disabled={!ready} busy={busy} />}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <div className="flex flex-col items-center gap-2 py-2">
          <PersonAvatar name={name || current} image={shownImage} size={112} />
          <input
            ref={file}
            type="file"
            accept="image/*"
            className="sr-only"
            aria-label={x.pickImage}
            onChange={(e) => {
              void pick(e.target.files?.[0])
              e.target.value = ''
            }}
          />
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => file.current?.click()}>
              <CameraIcon />
              {shownImage ? x.changeImage : x.pickImage}
            </Button>
            {shownImage ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => setImage(null)}>
                {x.removeImage}
              </Button>
            ) : null}
          </div>
        </div>
        <Field label={x.label} hint={x.hint}>
          {(a) => (
            <input
              {...a}
              type="text"
              value={shown}
              autoComplete="name"
              autoFocus
              maxLength={NAME_MAX}
              onChange={(e) => setValue(e.target.value)}
              className="h-11 w-full rounded-lg border border-border bg-card px-4 text-[15px] outline-none focus-visible:border-transparent focus-visible:ring-2 focus-visible:ring-ring"
            />
          )}
        </Field>
        {failed ? (
          <Callout tone="danger" role="alert">
            {failed === 'image' ? x.imageFailed : x.failed}
          </Callout>
        ) : null}
      </form>
    </FlowPage>
  )
}
