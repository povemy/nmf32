---
name: Bubbly Cyan Seller Studio
colors:
  surface: '#faf8ff'
  surface-dim: '#d2d9f4'
  surface-bright: '#faf8ff'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f2f3ff'
  surface-container: '#eaedff'
  surface-container-high: '#e2e7ff'
  surface-container-highest: '#dae2fd'
  on-surface: '#131b2e'
  on-surface-variant: '#3c4a47'
  inverse-surface: '#283044'
  inverse-on-surface: '#eef0ff'
  outline: '#6b7a77'
  outline-variant: '#bacac6'
  surface-tint: '#006a61'
  primary: '#006a61'
  on-primary: '#ffffff'
  primary-container: '#00c4b4'
  on-primary-container: '#004b44'
  inverse-primary: '#3edccc'
  secondary: '#006780'
  on-secondary: '#ffffff'
  secondary-container: '#76dcff'
  on-secondary-container: '#006077'
  tertiary: '#006c49'
  on-tertiary: '#ffffff'
  tertiary-container: '#2dc68d'
  on-tertiary-container: '#004d33'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#63f9e8'
  primary-fixed-dim: '#3edccc'
  on-primary-fixed: '#00201d'
  on-primary-fixed-variant: '#005049'
  secondary-fixed: '#b7eaff'
  secondary-fixed-dim: '#6cd3f7'
  on-secondary-fixed: '#001f28'
  on-secondary-fixed-variant: '#004e61'
  tertiary-fixed: '#6ffbbe'
  tertiary-fixed-dim: '#4edea3'
  on-tertiary-fixed: '#002113'
  on-tertiary-fixed-variant: '#005236'
  background: '#faf8ff'
  on-background: '#131b2e'
  surface-variant: '#dae2fd'
typography:
  display-hero:
    fontFamily: Plus Jakarta Sans
    fontSize: 3rem
    fontWeight: '800'
    lineHeight: 3.5rem
    letterSpacing: -0.03em
  headline-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 2rem
    fontWeight: '700'
    lineHeight: 2.5rem
    letterSpacing: -0.02em
  headline-lg-mobile:
    fontFamily: Plus Jakarta Sans
    fontSize: 1.75rem
    fontWeight: '700'
    lineHeight: 2.25rem
    letterSpacing: -0.02em
  headline-md:
    fontFamily: Plus Jakarta Sans
    fontSize: 1.5rem
    fontWeight: '700'
    lineHeight: 2rem
    letterSpacing: -0.02em
  headline-sm:
    fontFamily: Plus Jakarta Sans
    fontSize: 1.125rem
    fontWeight: '700'
    lineHeight: 1.5rem
    letterSpacing: -0.01em
  title-md:
    fontFamily: Plus Jakarta Sans
    fontSize: 1rem
    fontWeight: '600'
    lineHeight: 1.5rem
    letterSpacing: -0.01em
  body-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 1rem
    fontWeight: '400'
    lineHeight: 1.6rem
  body-md:
    fontFamily: Plus Jakarta Sans
    fontSize: 0.875rem
    fontWeight: '500'
    lineHeight: 1.4rem
  label-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 0.875rem
    fontWeight: '600'
    lineHeight: 1.25rem
  label-md:
    fontFamily: Plus Jakarta Sans
    fontSize: 0.75rem
    fontWeight: '600'
    lineHeight: 1rem
    letterSpacing: 0.01em
  label-sm:
    fontFamily: Plus Jakarta Sans
    fontSize: 0.6875rem
    fontWeight: '700'
    lineHeight: 0.875rem
    letterSpacing: 0.02em
  stat-counter:
    fontFamily: Plus Jakarta Sans
    fontSize: 1.875rem
    fontWeight: '800'
    lineHeight: 2.25rem
    letterSpacing: -0.025em
rounded:
  sm: 0.5rem
  DEFAULT: 1rem
  md: 1.5rem
  lg: 2rem
  xl: 3rem
  full: 9999px
spacing:
  gutter: 1.25rem
  gutter-mobile: 0.75rem
  margin: 2rem
  margin-mobile: 1rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 1rem
  space-lg: 1.5rem
  space-xl: 2rem
  space-2xl: 2.5rem
---

## Brand & Style

The design system establishes a refreshing, bubbly minimalist interface tailored for modern independent e-commerce merchants, DTC brands, and digital creators. The emotional goal is to turn dense financial and operational management into an uplifting, stress-free, and engaging experience. Sellers interact with critical sales performance, inventory pipelines, and revenue targets through soft tactile pill surfaces, expansive breathing room, and vibrant energetic accents.

Visually, this system merges soft tactile minimalism with rounded geometric playfulness. It rejects rigid corporate gridlines and cold monochromatic palettes in favor of silky milk-white canvases, deep charcoal typography for maximum legibility, pill-encapsulated navigation tags, and vivid electric cyan and mint-teal focal points. The vibe is nimble, optimistic, modern, and effortless.

## Colors

The palette centers on high-energy cyan and turquoise tones grounded in rich slate neutrals and bright off-white surfaces:

- **Primary (`#00c4b4` / `#06b6d4`):** The signature vibrant turquoise, used for highlight cards, active pill states, hero progress rings, and key micro-interactions.
- **Secondary (`#0891b2`):** Deep oceanic cyan providing anchored contrast for active toggles, chart gradients, and interactive hover states.
- **Tertiary (`#10b981`):** Fresh mint green serving positive percentage deltas, upward momentum badges, and growth indicators.
- **Neutral Palette:**
  - Canvas Background: `#f3f6f8` (soft, cool pale gray giving cards crisp definition).
  - Surface Card White: `#ffffff` (immaculate, luminous pure white).
  - Subtle Wells: `#f8fafc` to `#f1f5f9` for internal bar tracks, input backgrounds, and inset modules.
  - Text Primary: `#0f172a` (deep slate navy, delivering stark contrast without harsh pure black).
  - Text Secondary & Muted: `#64748b` for meta labels, dates, and secondary counters.
  - Border Lines: `#e2e8f0` (low-contrast structural dividers used sparingly).

## Typography

The type system is powered by **Plus Jakarta Sans**, providing warm geometric apertures, clean round bowls, and punchy contemporary numerals.

Large display numbers in seller metric blocks leverage ultra-bold weights (`800`) with snug negative tracking (`-0.025em`) to communicate substantial revenue values with confidence. Secondary details, axis markers, and unit labels utilize `600` weight at smaller scales to maintain crisp legibility on high-DPI displays without visual clutter.

## Layout & Spacing

The dashboard employs an asymmetric modular canvas structure inside an overall rounded container envelope. 

- **Grid Architecture:** Desktop view utilizes an asymmetric 12-column layout divided typically into an 8-column main analytical track and a 4-column side target/performance stack.
- **Card Containers:** Individual cards act as soft floating panels spaced by `1.25rem` gutters. Inner component padding follows a generous `1.5rem` to `2rem` cushion (`space-lg` to `space-xl`), allowing high-level numbers to stand out distinctly.
- **Responsive Adaptations:**
  - On desktop (1280px+), sidebar panels, metric bands, and multi-tier charts sit in balanced dual columns.
  - On tablet (768px–1024px), horizontal 3-card metric bars wrap gracefully into 2-row cards.
  - On mobile (&lt;768px), the layout reflows into a single vertical scroll stream with horizontal carousel scrolling for product grids and metric summaries. Margins condense to `1rem`.

## Elevation & Depth

Visual hierarchy uses ultra-diffused, ambient multi-layered shadows combined with tactile surface colors rather than stark hard lines:

- **Level 0 (Canvas Base):** Flat cool tint (`#f3f6f8`), acting as the soft backdrop.
- **Level 1 (Card Panels):** Pure white surfaces resting with `box-shadow: 0 10px 30px -5px rgba(15, 23, 42, 0.04), 0 4px 12px -2px rgba(15, 23, 42, 0.02)`.
- **Level 2 (Pill Modals & Popovers):** Elevated contextual chips (such as tooltip metric bubbles) with `box-shadow: 0 12px 24px -4px rgba(0, 196, 180, 0.25)`.
- **Level 3 (Hero Gradient Surfaces):** Cards with saturated cyan-teal gradients (`linear-gradient(135deg, #00c4b4 0%, #0891b2 100%)`) featuring a colored glow: `0 16px 32px -8px rgba(0, 196, 180, 0.35)`.
- **Borders:** Thin structural outlines (`1px solid rgba(226, 232, 240, 0.6)`) are selectively paired with soft shadows to keep crisp definitions around product image tiles and inset search inputs.

## Shapes

The design system embraces an ultra-rounded "bubbly" silhouette language:

- **Outer App Container & Major Cards:** Sculpted with deep radii (`1.75rem` to `2rem` / `28px` to `32px`).
- **Interactive Buttons & Badges:** Full pill execution (`border-radius: 9999px`) for action chips, search bars, header navigation, and status indicators.
- **Inner Content Blocks & Product Images:** Soft rounded geometry (`1rem` to `1.25rem` / `16px` to `20px`) ensuring nested elements echo the outer card curvature without sharp corners.
- **Bar Charts:** Pill-capped vertical pill bars with curved rounded tips.

## Components

### Buttons & Navigation Pills
- **Primary Pill:** Background filled with `#00c4b4` or deep gradient into `#0891b2`, crisp white text, fully rounded pill radius (`9999px`), padding `0.75rem 1.5rem`.
- **Header Nav Pills:** Inactive navigation links sit without background in `#64748b` text; active item is encased in a colored pill capsule with bright white text and subtle teal shadow.
- **Icon Quick Action:** Circular or squircle button (`40px × 40px`) with inset rounded icon (e.g., arrow top-right `↗`), off-white background `#f8fafc`, transitioning to soft cyan hover.

### Metric Cards & Stat Blocks
- **Hero Metric Card:** Colored solid turquoise with contrasting crisp white typography, containing metric title, micro arrow pill button, and large tabular numbers (`$8,136.25`).
- **Standard Metric Card:** Pure white background, bold navy headline figures, accompanied by mini trend badges (e.g., `+18%` pill in mint tertiary `#10b981`).

### Chips & Badges
- **Percentage & Tag Pills:** Ultra-compact pill badges (`0.25rem 0.625rem`) with soft tinted background (`rgba(0, 196, 180, 0.1)`) and high-contrast saturated text.
- **Discount & Status Labels:** Rounded squircle tags (`8px` radius) positioned dynamically at the top corner of product thumbnails.

### Charts & Progress Rings
- **Semi-Circular Gauge:** Bold sweep track in tinted surface gray (`#f1f5f9`), overlaid by vibrant teal progress arc (`16px` stroke width) with centered large percentage and positive indicator.
- **Pill Column Bars:** Segmented or striped vertical bars with fully rounded ends (`border-radius: 9999px`). Active/selected column lights up in vibrant cyan-teal, while neighboring inactive columns remain soft neutral gray (`#f1f5f9`).

### Product Catalog Cards
- **Product Tiles:** Clean vertical stack with light background image cards (`rounded-2xl`), product titles in `#0f172a`, and tabular prices with colorway indicator dots below.

### Inputs & Search Bars
- **Pill Search Field:** Encapsulated within `9999px` pill border, light gray fill (`#f8fafc`), clean search glyph on the left, zero outer stroke until focused (then subtle `#00c4b4` glow ring).