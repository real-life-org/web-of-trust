export function ListHeader({ title, count }: { title: string; count?: string | undefined }) {
  return (
    <header className="flex flex-none items-center justify-between px-5 pt-[18px] pb-2.5">
      <h1 className="m-0 text-[22px] font-bold tracking-[-0.02em]">{title}</h1>
      {count ? <span className="text-xs text-muted-foreground">{count}</span> : null}
    </header>
  )
}
