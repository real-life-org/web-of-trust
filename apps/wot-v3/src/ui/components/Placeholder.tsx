/** Centered muted text: desktop detail pane without selection, areas that follow later. */
export function CenteredNote({ text }: { text: string }) {
  return <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">{text}</div>
}
