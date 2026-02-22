/**
 * Seed data for activity categories.
 *
 * Categories define the activity groupings shown in the UI with their
 * associated mineral color styles. This file is:
 *   1. Imported by db-init to seed MongoDB
 *   2. Scanned by Tailwind JIT to generate CSS classes for category styles
 *
 * IMPORTANT: All Tailwind class names must appear as complete string literals
 * in this file so Tailwind JIT can detect and generate them. Never construct
 * class names dynamically.
 */

export interface ActivityCategoryDoc {
  /** Category identifier (e.g. "farming", "sports") */
  id: string;
  /** Display label */
  label: string;
  /** Sort order for UI display */
  order: number;
  /**
   * Mineral color CSS classes (must be complete Tailwind class names).
   *
   * Trust boundary: these class strings are applied directly via className in
   * React components. They come from app-seeded data (this file → db-init →
   * MongoDB), NOT from user input. Never derive these values from untrusted
   * sources (user submissions, query params, etc.).
   */
  style: {
    bg: string;
    border: string;
    text: string;
    badge: string;
  };
  updatedAt?: Date;
}

/**
 * Seed categories with mineral color styles.
 * Order determines display sequence in category filter pills.
 */
export const CATEGORIES: ActivityCategoryDoc[] = [
  {
    id: "farming",
    label: "Farming",
    order: 1,
    style: {
      bg: "bg-mineral-malachite/10",
      border: "border-mineral-malachite",
      text: "text-mineral-malachite",
      badge: "bg-mineral-malachite text-mineral-malachite-fg",
    },
  },
  {
    id: "mining",
    label: "Mining",
    order: 2,
    style: {
      bg: "bg-mineral-terracotta/10",
      border: "border-mineral-terracotta",
      text: "text-mineral-terracotta",
      badge: "bg-mineral-terracotta text-mineral-terracotta-fg",
    },
  },
  {
    id: "travel",
    label: "Travel",
    order: 3,
    style: {
      bg: "bg-mineral-cobalt/10",
      border: "border-mineral-cobalt",
      text: "text-mineral-cobalt",
      badge: "bg-mineral-cobalt text-mineral-cobalt-fg",
    },
  },
  {
    id: "tourism",
    label: "Tourism",
    order: 4,
    style: {
      bg: "bg-mineral-tanzanite/10",
      border: "border-mineral-tanzanite",
      text: "text-mineral-tanzanite",
      badge: "bg-mineral-tanzanite text-mineral-tanzanite-fg",
    },
  },
  {
    id: "sports",
    label: "Sports",
    order: 5,
    style: {
      bg: "bg-mineral-gold/10",
      border: "border-mineral-gold",
      text: "text-mineral-gold",
      badge: "bg-mineral-gold text-mineral-gold-fg",
    },
  },
  {
    id: "casual",
    label: "Casual",
    order: 6,
    style: {
      bg: "bg-primary/10",
      border: "border-primary",
      text: "text-primary",
      badge: "bg-primary text-primary-foreground",
    },
  },
];
