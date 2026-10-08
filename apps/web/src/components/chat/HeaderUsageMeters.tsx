import { useAtomValue } from "@effect/atom-react";
import {
  collectLimitAccounts,
  collectLimitPools,
  displayLimitWindows,
  isLimitPoolWindowExpired,
  type LimitPool,
} from "@t3tools/shared/usageLimits";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRightIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { environmentPresentations } from "../../state/presentation";
import { getDriverOption } from "../settings/providerDriverMeta";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { LimitWindows, barColor } from "../usage/UsageLimits";
import { readUsagePagePreferences, saveUsagePagePreferences } from "../usage/usagePagePreferences";
import { AccountSummary } from "./ComposerUsageLimits";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

/** The first displayed window on top, the next as a thinner bar under it. */
function meterWindows(pool: LimitPool) {
  return displayLimitWindows(pool).slice(0, 2);
}

/**
 * Subscription quota for every connected provider, pooled across environments
 * like the usage page. Each meter shows the pool; selecting one lists each
 * account's windows in the composer's compact rows. Accounts and resets are
 * managed on the usage page. `now` advances when a popover opens and once when
 * the next shown reading expires, rather than ticking: a live clock would
 * repaint the header for no decision-changing gain. Hidden when the header is
 * too narrow to spare the room.
 */
export function HeaderUsageMeters() {
  const mode = useClientSettings((settings) => settings.usageMeterMode);
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const [now, setNow] = useState(() => Date.now());
  const pools = mode === "none" ? [] : collectLimitPools(collectLimitAccounts(presentations), now);
  const nextExpiry = Math.min(
    ...pools.flatMap((pool) =>
      meterWindows(pool).flatMap((window) => {
        const at = window.resets[0]?.at;
        return at !== undefined && at > now ? [at] : [];
      }),
    ),
  );
  // setTimeout overflows past about 24 days, so a later expiry wakes early and reschedules.
  const wakeAt = Number.isFinite(nextExpiry) ? Math.min(nextExpiry, now + 2 ** 31 - 1) : null;
  useEffect(() => {
    if (wakeAt === null) return;
    const timer = setTimeout(() => setNow(Date.now()), wakeAt - Date.now());
    return () => clearTimeout(timer);
  }, [wakeAt]);
  if (pools.length === 0) return null;
  return (
    <div className="hidden shrink-0 items-center gap-1 @2xl/header:flex">
      {pools.map((pool) => (
        <ProviderMeter
          key={pool.driver}
          pool={pool}
          now={now}
          showBars={mode !== "percent"}
          showPercent={mode !== "bars"}
          onOpen={() => setNow(Date.now())}
        />
      ))}
    </div>
  );
}

function ProviderMeter({
  pool,
  now,
  showBars,
  showPercent,
  onOpen,
}: {
  readonly pool: LimitPool;
  readonly now: number;
  readonly showBars: boolean;
  readonly showPercent: boolean;
  readonly onOpen: () => void;
}) {
  const navigate = useNavigate();
  const label = getDriverOption(pool.driver)?.label ?? String(pool.driver);
  const color = barColor(pool.driver);
  const poolWindows = displayLimitWindows(pool);
  const shown = meterWindows(pool).map((window) => ({
    window,
    expired: isLimitPoolWindowExpired(window, now),
  }));
  const [primary] = shown;
  const summary = shown
    .map(
      ({ window, expired }) =>
        `${window.label} ${expired ? "unknown" : `${window.remainingPercent}% left`}`,
    )
    .join(", ");
  // Each account's windows in the pool's display order; Cursor's combined
  // window can drop out, so an account may have none left to show.
  const accounts = pool.accounts.flatMap((account) => {
    const windows = poolWindows.flatMap((window) =>
      window.members
        .filter((member) => member.account.key === account.key)
        .map((member) => member.window),
    );
    return windows.length > 0 ? [{ account, windows }] : [];
  });
  return (
    <Popover
      onOpenChange={(open) => {
        if (open) onOpen();
      }}
    >
      <PopoverTrigger
        render={
          <Button variant="ghost-muted" size="xs" aria-label={`${label} usage: ${summary}`} />
        }
      >
        <ProviderInstanceIcon
          driverKind={pool.driver}
          displayName={label}
          className="size-3.5"
          iconClassName="size-3.5 text-foreground/80"
        />
        {showBars ? (
          <span className="flex w-10 flex-col gap-0.5">
            {shown.map(({ window, expired }, index) => (
              <MeterBar
                key={`${window.kind}:${window.id}`}
                remainingPercent={expired ? null : window.remainingPercent}
                color={color}
                thick={index === 0}
              />
            ))}
          </span>
        ) : null}
        {showPercent && primary ? (
          <span className="min-w-6 text-2xs font-medium text-muted-foreground tabular-nums">
            {primary.expired ? "?" : `${primary.window.remainingPercent}%`}
          </span>
        ) : null}
      </PopoverTrigger>
      <PopoverPopup
        width="lg"
        side="bottom"
        align="end"
        aria-label={`${label} usage limits`}
        // The meters hide when the header narrows; an open popup must not outlive them.
        className="in-data-anchor-hidden:hidden"
      >
        <div className="flex flex-col gap-3">
          <span className="flex items-center gap-2 text-sm font-medium text-foreground">
            <ProviderInstanceIcon
              driverKind={pool.driver}
              displayName={label}
              className="size-4"
              iconClassName="size-4 text-foreground/80"
            />
            {label}
          </span>
          {accounts.map(({ account, windows }) => (
            <div key={account.key} className="flex min-w-0 flex-col gap-1">
              {accounts.length > 1 ? (
                <span className="truncate text-xs text-muted-foreground">
                  <AccountSummary
                    label={account.displayName ?? account.email ?? ""}
                    plan={account.plan}
                  />
                </span>
              ) : null}
              <LimitWindows compact driver={pool.driver} windows={windows} now={now} />
            </div>
          ))}
          <Button
            variant="ghost-muted"
            size="xs"
            className="self-end"
            onClick={() => {
              // The page reopens its last metric; arriving from here should show limits.
              saveUsagePagePreferences({ ...readUsagePagePreferences(), metric: "limits" });
              void navigate({ to: "/usage" });
            }}
          >
            Usage dashboard
            <ArrowRightIcon className="size-3.5" aria-hidden="true" />
          </Button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/**
 * Quota left as a depleting fill: full when fresh, empty when the window is
 * spent. An expired reading has no fill and a fainter track, so it reads as
 * unknown rather than spent.
 */
function MeterBar({
  remainingPercent,
  color,
  thick,
}: {
  readonly remainingPercent: number | null;
  readonly color: string;
  readonly thick: boolean;
}) {
  return (
    <span
      aria-hidden
      className={cn("relative block overflow-hidden rounded-full", thick ? "h-1.5" : "h-1")}
      // A faint tint of the fill keeps the full length readable when little quota remains.
      style={{
        backgroundColor: `color-mix(in srgb, ${color} ${remainingPercent === null ? 8 : 20}%, transparent)`,
      }}
    >
      {remainingPercent === null ? null : (
        <span
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ width: `${remainingPercent}%`, backgroundColor: color }}
        />
      )}
    </span>
  );
}
