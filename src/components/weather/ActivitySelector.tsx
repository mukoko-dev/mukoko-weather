"use client";

import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { useAppStore } from "@/lib/store";
import {
  ACTIVITIES,
  ACTIVITY_CATEGORIES,
  CATEGORY_STYLES,
  searchActivities,
  type ActivityCategory,
} from "@/lib/activities";
import { ActivityIcon } from "@/lib/weather-icons";

/** Get the category style or fall back to casual/primary */
function getCategoryStyle(category: string) {
  return CATEGORY_STYLES[category] ?? CATEGORY_STYLES.casual;
}

export function ActivitySelector() {
  const selectedActivities = useAppStore((s) => s.selectedActivities);
  const [open, setOpen] = useState(false);

  const selectedItems = useMemo(
    () => ACTIVITIES.filter((a) => selectedActivities.includes(a.id)),
    [selectedActivities],
  );

  return (
    <>
      {/* Card shown on page */}
      <section aria-labelledby="activities-heading">
        <div className="rounded-[var(--radius-card)] bg-surface-card p-4 shadow-sm sm:p-6">
          <div className="flex items-center justify-between">
            <h2 id="activities-heading" className="text-lg font-semibold text-text-primary font-heading">
              My Activities
            </h2>
            <button
              onClick={() => setOpen(true)}
              className="rounded-[var(--radius-button)] bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
              aria-label={selectedItems.length > 0 ? "Edit your activities" : "Add activities"}
            >
              {selectedItems.length > 0 ? "Edit" : "Add"}
            </button>
          </div>

          {selectedItems.length === 0 ? (
            <p className="mt-3 text-sm text-text-tertiary">
              Select activities to get personalised weather advice for farming, travel, sports, and more.
            </p>
          ) : (
            <div className="mt-3 grid gap-2" role="list" aria-label="Selected activities">
              {selectedItems.map((a) => {
                const style = getCategoryStyle(a.category);
                return (
                  <div
                    key={a.id}
                    role="listitem"
                    className={`flex items-center gap-3 rounded-[var(--radius-card)] border p-3 ${style.bg} ${style.border}`}
                  >
                    <span className={`shrink-0 ${style.text}`} aria-hidden="true">
                      <ActivityIcon activity={a.id} size={20} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className={`text-sm font-semibold ${style.text}`}>{a.label}</p>
                      <p className="text-xs text-text-tertiary">{a.description}</p>
                    </div>
                    <span className={`shrink-0 rounded-[var(--radius-badge)] px-2 py-0.5 text-xs font-medium ${style.badge}`}>
                      {ACTIVITY_CATEGORIES.find((c) => c.id === a.category)?.label ?? a.category}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* Selection modal */}
      {open && <ActivityModal onClose={() => setOpen(false)} />}
    </>
  );
}

function ActivityModal({ onClose }: { onClose: () => void }) {
  const selectedActivities = useAppStore((s) => s.selectedActivities);
  const toggleActivity = useAppStore((s) => s.toggleActivity);
  const [activeCategory, setActiveCategory] = useState<ActivityCategory | "all">("all");
  const [query, setQuery] = useState("");
  const overlayRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the search input on open
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  // Prevent body scroll when modal is open
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === overlayRef.current) onClose();
    },
    [onClose],
  );

  const filteredActivities = useMemo(() => {
    let items = query ? searchActivities(query) : ACTIVITIES;
    if (activeCategory !== "all") {
      items = items.filter((a) => a.category === activeCategory);
    }
    return items;
  }, [query, activeCategory]);

  return (
    <div
      ref={overlayRef}
      onClick={handleOverlayClick}
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label="Add Activities"
    >
      <div className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-t-2xl bg-surface-card sm:rounded-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h3 className="text-lg font-semibold text-text-primary font-heading">Add Activities</h3>
          <button
            onClick={onClose}
            className="rounded-[var(--radius-button)] bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Done
          </button>
        </div>

        {/* Category tabs */}
        <div className="flex gap-2 overflow-x-auto px-4 pt-3 pb-2 scrollbar-hide" role="tablist" aria-label="Activity categories">
          <CategoryTab
            label="All"
            categoryId="all"
            active={activeCategory === "all"}
            onClick={() => setActiveCategory("all")}
          />
          {ACTIVITY_CATEGORIES.map((cat) => (
            <CategoryTab
              key={cat.id}
              label={cat.label}
              categoryId={cat.id}
              active={activeCategory === cat.id}
              onClick={() => setActiveCategory(cat.id)}
            />
          ))}
        </div>

        {/* Search */}
        <div className="px-4 pb-2">
          <div className="flex items-center gap-2 rounded-[var(--radius-input)] bg-surface-base px-3 py-2">
            <svg className="shrink-0 text-text-tertiary" width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
            </svg>
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search"
              className="w-full bg-transparent text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none"
              aria-label="Search activities"
            />
          </div>
        </div>

        {/* Activity grid */}
        <div className="flex-1 overflow-y-auto px-4 pb-4">
          <div className="grid grid-cols-2 gap-2.5" role="group" aria-label="Available activities">
            {filteredActivities.map((activity) => {
              const isSelected = selectedActivities.includes(activity.id);
              const style = getCategoryStyle(activity.category);
              return (
                <button
                  key={activity.id}
                  onClick={() => toggleActivity(activity.id)}
                  aria-pressed={isSelected}
                  aria-label={`${activity.label}: ${activity.description}`}
                  className={`relative flex min-h-[88px] flex-col items-center justify-center gap-2 rounded-[var(--radius-card)] border-2 p-3 transition-colors ${
                    isSelected
                      ? `${style.border} ${style.bg}`
                      : "border-transparent bg-surface-base hover:border-text-tertiary/30"
                  }`}
                >
                  {isSelected && (
                    <span className={`absolute top-1.5 right-1.5 flex h-5 w-5 items-center justify-center rounded-full ${style.badge}`} aria-hidden="true">
                      <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    </span>
                  )}
                  <ActivityIcon
                    activity={activity.id}
                    size={28}
                    className={isSelected ? style.text : "text-text-tertiary"}
                  />
                  <span className={`text-sm font-medium ${isSelected ? style.text : "text-text-secondary"}`}>
                    {activity.label}
                  </span>
                </button>
              );
            })}
          </div>

          {filteredActivities.length === 0 && (
            <p className="py-8 text-center text-sm text-text-tertiary">
              No activities found for &ldquo;{query}&rdquo;
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function CategoryTab({
  label,
  categoryId,
  active,
  onClick,
}: {
  label: string;
  categoryId: string;
  active: boolean;
  onClick: () => void;
}) {
  const style = categoryId === "all" ? null : getCategoryStyle(categoryId);

  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`shrink-0 rounded-[var(--radius-badge)] px-3 py-1.5 text-sm font-medium transition-colors ${
        active
          ? style ? `${style.badge}` : "bg-primary text-primary-foreground"
          : "bg-surface-base text-text-secondary hover:text-text-primary"
      }`}
    >
      {label}
    </button>
  );
}
