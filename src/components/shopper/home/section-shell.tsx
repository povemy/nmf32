"use client";
// ============================================================================
// Shared section shell — consistent header (icon + title + subtitle + view-all
// destination) for every homepage section. Replaces the old SectionBlock
// inside market.tsx so sections share one visual rhythm.
// ============================================================================
import { motion } from "framer-motion";
import { ChevronRight } from "lucide-react";

export function SectionShell({
  id,
  title,
  subtitle,
  icon,
  viewAll,
  children,
}: {
  id?: string;
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  viewAll?: { label: string; onClick: () => void };
  children: React.ReactNode;
}) {
  return (
    <motion.section
      id={id}
      initial={{ opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-60px" }}
      transition={{ duration: 0.35, ease: "easeOut" }}
      className="space-y-4"
    >
      <div className="flex items-end justify-between gap-3">
        <div className="flex items-center gap-2.5">
          {icon}
          <div>
            <h2 className="text-lg font-bold tracking-tight">{title}</h2>
            <p className="text-xs text-muted-foreground">{subtitle}</p>
          </div>
        </div>
        {viewAll ? (
          <button
            type="button"
            onClick={viewAll.onClick}
            className="inline-flex min-h-[44px] shrink-0 items-center gap-1 rounded-full border px-3.5 text-xs font-semibold text-teal-800 transition-colors hover:bg-teal-50"
            aria-label={viewAll.label}
          >
            {viewAll.label} <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {children}
    </motion.section>
  );
}
