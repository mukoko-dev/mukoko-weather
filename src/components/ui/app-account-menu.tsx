"use client";

/**
 * Mzizi App Account Menu — vendored from the Mzizi registry
 * (`npx shadcn@latest add https://api.mzizi.dev/v1/ui/app-account-menu`,
 * components/registry/n7-shell/app-account-menu.tsx at registry commit
 * 780457ae94afd5229a78a5d7ba5146bda8260812, contract `app/account-menu`).
 * Keep it in step with upstream: behaviour changes go to
 * mzizi-dev/mzizi-registry first.
 *
 * Upstream: who is signed in, the app's own account actions (children), and
 * sign-out as a POST form, in a `<details>` disclosure — it opens with the
 * keyboard and screen readers and needs no script. This app uses it as the ONE
 * phone menu (owner rule: Mzizi registry components first). Why a `<details>`
 * popover and not the registry `bottom-sheet` / `drawer`: the menu is the
 * account menu (identity, the app's links, sign-out) that the Mzizi shell
 * standard puts at the end of the top bar, and about ten 48px rows fit a
 * scrolling 18rem panel under the trigger; a sheet would add a second overlay
 * pattern to a screen that already has the My Weather dialog.
 *
 * Local changes from upstream, each because the registry build cannot meet a
 * requirement of this app as published:
 *
 * 1. Signed-out visitors. Upstream always says "Signed in" with initials.
 *    Here a visitor with no `name`/`email` gets the user icon, no identity
 *    header and a "Sign in" row (`signInHref`) instead of the sign-out form.
 * 2. `trigger`, `triggerLabel`, `triggerClassName`. The hero's top row is a
 *    round 48px control over the sky (`kestrel-round`), and the header's action
 *    pill carries a ⋯; upstream fixes the trigger to a 32px row with a 24px
 *    avatar and a name from `xl`. With no `triggerClassName` the upstream look
 *    is kept (avatar row, name from `xl`).
 * 3. `initials` and `imageUrl` are passed in. Upstream derives initials by
 *    splitting the name; this app already has `initialsFor` (first and last
 *    name, else the email's first letter) and a profile picture guarded by
 *    `isValidImageUrl`.
 * 4. Touch targets use `--touch-target-min` (48px). Upstream's coarse-pointer
 *    height is 44px (`pointer-coarse:h-11`); this app's floor is 48px.
 * 5. No shadow and a token radius: upstream's panel is `shadow-lg` and
 *    `rounded-md`. Mzizi separates surfaces with borders and this repo
 *    refuses the shorthand radii (`rounded-[var(--radius-card)]`,
 *    `rounded-[var(--radius-sm)]`). Text sizes are the `--text-*` scale tokens
 *    (the registry's `text-body-sm` / `text-caption` utilities are not
 *    registered in this app's Tailwind theme).
 * 6. The panel scrolls (`max-h-[calc(100dvh-7rem)]`): with the app's rows it is
 *    taller than a landscape phone. The slot wrapper is `p-1`, not `px-3 py-2`,
 *    because the slot holds full-width rows that carry their own padding.
 * 7. Closing. A bare `<details>` stays open on Escape, an outside tap, a chosen
 *    link and when focus walks away. A small effect closes it on Escape
 *    (focus returns to the trigger), on a `pointerdown` outside (not
 *    `mousedown`: iOS Safari synthesises no mouse events for a tap on a
 *    non-clickable element, so a mouse listener never fires there), and when
 *    a link or a row marked `data-close-menu` is activated. A `blur` handler
 *    closes it when focus moves to an element outside the menu (Tab or
 *    Shift+Tab away); a `relatedTarget` of `null` (a click on the panel's own
 *    padding, the window losing focus) is not "leaving", so it stays open. It
 *    adds no state the markup depends on: without script the menu still opens
 *    and closes natively.
 * 8. `aria-controls` points the trigger at the panel (a `useId`, since the
 *    header and the hero each mount one). The expanded state stays the native
 *    `<details>` one; no `aria-expanded` is set by hand, so the two cannot
 *    disagree.
 * 9. The account name inside the panel is a `<p>` as upstream; its accessible
 *    trigger name is "Account menu for {name}" (or "Account menu" signed out,
 *    or `triggerLabel`) at every width, not only below `xl`, because the
 *    round triggers show no text.
 *
 * 10. `onOpenChange` tells the app when the disclosure opens or closes, so a
 *    row inside it (the notifications note) can reset when the menu closes.
 * 11. Phones: the panel is `fixed` to the viewport's right gutter (`right-2`),
 *    not `absolute` under its trigger. Upstream right-aligns the panel to the
 *    trigger, which assumes the trigger sits at the right edge. The header's
 *    ⋯ is the first of three buttons in the action pill (about 118px from the
 *    right edge), so a 288px panel right-aligned to it started 31px left of
 *    the screen at 375px wide and was clipped. `fixed` with no `top` keeps the
 *    panel at its static position, directly under the trigger; `w-[min(18rem,
 *    calc(100vw-1rem))]` never exceeds the viewport minus the 0.5rem gutters,
 *    so its left edge is always at or past the left gutter whatever the
 *    trigger's place. From `sm` it is the upstream `absolute right-0` again.
 *
 * Sign-out stays upstream's POST form (so no other page can trigger it with a
 * link). `/auth/signout` accepts the POST (a same-origin check) and answers
 * 303 to the existing sign-out route, which performs the WorkOS sign-out, so
 * the sign-out behaviour is unchanged; the profile page keeps its GET link.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { LogOut, User } from "lucide-react";
import { cn } from "@/lib/utils";
import { isValidImageUrl } from "@/lib/user-display";

export interface AccountMenuProps {
  name?: string | null;
  email?: string | null;
  /** Initials for the avatar (the app's `initialsFor`). */
  initials?: string;
  /** Profile picture; only an in-app path or an http(s) URL is drawn. */
  imageUrl?: string | null;
  /** Where the sign-out form posts. Omit to leave sign-out to the children. */
  signOutAction?: string;
  signOutLabel?: string;
  /** Where "Sign in" goes for a signed-out visitor. */
  signInHref?: string;
  signInLabel?: string;
  /** Replaces the default avatar inside the trigger (the header's ⋯). */
  trigger?: ReactNode;
  /** The trigger's accessible name; defaults to "Account menu for {name}". */
  triggerLabel?: string;
  /** Replaces the default avatar-row look (the hero's round control). */
  triggerClassName?: string;
  /** Called with the new open state (the disclosure's toggle). */
  onOpenChange?: (open: boolean) => void;
  children?: ReactNode;
}

/** One 48px row, for the slot and the sign-in / sign-out rows. */
export const ACCOUNT_MENU_ROW_CLASS =
  "flex min-h-[var(--touch-target-min)] w-full items-center gap-2 rounded-[var(--radius-sm)] px-3 text-left text-base font-semibold text-text-primary transition-colors hover:bg-surface-dim focus-visible:outline-2 focus-visible:outline-primary aria-[current=page]:text-primary";

function AccountMenu({
  name = null,
  email = null,
  initials,
  imageUrl = null,
  signOutAction,
  signOutLabel = "Sign out",
  signInHref,
  signInLabel = "Sign in",
  trigger,
  triggerLabel,
  triggerClassName,
  onOpenChange,
  children,
}: AccountMenuProps) {
  const signedIn = Boolean(name || email);
  const shown = name ?? email ?? "Your account";
  const panelId = useId();
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);

  const close = () => {
    if (ref.current) ref.current.open = false;
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      close();
      ref.current?.querySelector<HTMLElement>("summary")?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const hasChildren =
    children !== undefined &&
    children !== null &&
    children !== false &&
    children !== "";

  const avatar =
    trigger ??
    (signedIn ? (
      isValidImageUrl(imageUrl) ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imageUrl ?? undefined}
          alt=""
          className="h-full w-full rounded-full object-cover"
          referrerPolicy="no-referrer"
        />
      ) : (
        <span
          aria-hidden="true"
          className={cn(
            "inline-flex items-center justify-center text-[length:var(--text-caption)] leading-[var(--text-caption-leading)] font-semibold",
            !triggerClassName &&
              "h-6 w-6 rounded-full bg-muted ring-1 ring-border",
          )}
        >
          {initials ?? "?"}
        </span>
      )
    ) : (
      <User size={20} aria-hidden="true" />
    ));

  return (
    <details
      ref={ref}
      className="group relative"
      data-slot="account-menu"
      onToggle={(e) => {
        setOpen(e.currentTarget.open);
        onOpenChange?.(e.currentTarget.open);
      }}
      onBlur={(e) => {
        // Focus left the menu for another element (Tab / Shift+Tab). A null
        // relatedTarget is a click on non-focusable panel padding or the
        // window losing focus: not leaving, and pointerdown covers outside taps.
        const next = e.relatedTarget;
        if (next instanceof Node && !e.currentTarget.contains(next)) close();
      }}
    >
      <summary
        aria-controls={panelId}
        className={cn(
          "cursor-pointer list-none outline-none [&::-webkit-details-marker]:hidden",
          triggerClassName ??
            "flex h-8 items-center gap-2 rounded-[var(--radius-sm)] px-1 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-[var(--touch-target-min)]",
          // The round hero trigger crops an avatar photo to its circle.
          triggerClassName && "overflow-hidden",
        )}
      >
        {avatar}
        {!triggerClassName && !trigger && (
          <span className="hidden max-w-40 truncate text-[length:var(--text-body-sm)] leading-[var(--text-body-sm-leading)] font-semibold xl:inline">
            {shown}
          </span>
        )}
        <span className="sr-only">
          {triggerLabel ??
            (signedIn ? `Account menu for ${shown}` : "Account menu")}
        </span>
      </summary>
      <div
        id={panelId}
        className="fixed right-2 sm:absolute sm:right-0 z-40 mt-1 max-h-[calc(100dvh-7rem)] w-[min(18rem,calc(100vw-1rem))] overflow-y-auto rounded-[var(--radius-card)] border border-border bg-popover p-1 text-left text-popover-foreground"
        data-slot="account-menu-panel"
        onClick={(e) => {
          if ((e.target as Element).closest("a, [data-close-menu]")) close();
        }}
      >
        {signedIn && (
          <div className="px-3 py-2">
            <p className="truncate text-[length:var(--text-body-sm)] leading-[var(--text-body-sm-leading)] font-semibold">
              {name ?? "Signed in"}
            </p>
            {email && (
              <p className="truncate text-[length:var(--text-caption)] leading-[var(--text-caption-leading)] text-muted-foreground">
                {email}
              </p>
            )}
          </div>
        )}
        {hasChildren && (
          <div className={cn("p-1", signedIn && "border-t border-border")}>
            {children}
          </div>
        )}
        {!signedIn && signInHref && (
          <div className="border-t border-border p-1">
            <Link
              href={signInHref}
              prefetch={false}
              className={ACCOUNT_MENU_ROW_CLASS}
            >
              <User
                size={16}
                className="text-muted-foreground"
                aria-hidden="true"
              />
              {signInLabel}
            </Link>
          </div>
        )}
        {signedIn && signOutAction && (
          <form
            method="post"
            action={signOutAction}
            className="border-t border-border p-1"
          >
            <button type="submit" className={ACCOUNT_MENU_ROW_CLASS}>
              <LogOut
                size={16}
                className="text-muted-foreground"
                aria-hidden="true"
              />
              {signOutLabel}
            </button>
          </form>
        )}
      </div>
    </details>
  );
}

export { AccountMenu };
