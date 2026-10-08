/** Skeleton matching the display's landscape layout (readings left, map right). */
export default function DisplayLoading() {
  return (
    <div
      className="flex min-h-dvh flex-col gap-4 bg-background p-4 lg:h-dvh lg:p-6"
      role="status"
      aria-label="Loading weather display"
    >
      <div className="chameleon h-16" />
      <div className="grid flex-1 gap-4 lg:grid-cols-12">
        <div className="flex flex-col gap-4 lg:col-span-5">
          <div className="chameleon h-64" />
          <div className="chameleon h-40" />
        </div>
        <div className="flex flex-col gap-4 lg:col-span-7">
          <div className="chameleon min-h-[18rem] flex-1" />
          <div className="chameleon h-28" />
          <div className="chameleon h-28" />
        </div>
      </div>
    </div>
  );
}
