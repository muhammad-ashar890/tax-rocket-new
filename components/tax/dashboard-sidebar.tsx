"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Calculator,
  CreditCard,
  FileText,
  FolderOpen,
  Headphones,
  Home,
  Link2,
  Scale,
  Settings,
  User,
} from "lucide-react";
import { cn } from "@/lib/utils";

// DashboardSidebar — left-hand navigation column for the dashboard,
// styled after the Befiler reference (left nav + "Quick Links" list +
// a help/support card at the bottom) but wired to TaxRocket's own
// routes and vocabulary (Ledgers/Mizan, FBR Connect, etc.) — no
// marketing content, no pricing links, matching the earlier decision to
// keep this purely functional.

const primaryLinks = [
  { href: "/tax/dashboard", label: "Home", icon: Home },
  { href: "/tax/new", label: "New Filing", icon: FileText },
  { href: "/tax/history", label: "History", icon: FolderOpen },
  { href: "/tax/fbr-connect", label: "FBR Connect", icon: Link2 },
  { href: "/tax/profile", label: "Profile", icon: User },
  { href: "/tax/settings", label: "Settings", icon: Settings },
];

const quickLinks = [
  { href: "/tax/mizan", label: "Mizan (Wealth Check)", icon: Scale },
  {
    href: "/tax/calculators",
    label: "Salary Tax Calculator",
    icon: Calculator,
  },
  { href: "/tax/guide", label: "NTN / CNIC Guide", icon: CreditCard },
];

export function DashboardSidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden lg:block">
      <div className="space-y-4 lg:sticky lg:top-20">
        <nav className="rounded-2xl border bg-card p-2 shadow-sm">
          {primaryLinks.map((link) => {
            const isActive = pathname === link.href;
            return (
              <Link
                key={link.href}
                href={link.href}
                className={cn(
                  "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-amanah text-white shadow-sm"
                    : "text-foreground hover:bg-muted",
                )}
              >
                <link.icon className="h-4 w-4 shrink-0" />
                {link.label}
              </Link>
            );
          })}
        </nav>

        {/* <div className="rounded-2xl border bg-card p-4 shadow-sm">
          <p className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Quick Links
          </p>
          <div className="space-y-0.5">
            {quickLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="flex items-center gap-3 rounded-lg px-2 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <link.icon className="h-4 w-4 shrink-0" />
                {link.label}
              </Link>
            ))}
          </div>
        </div> */}

        <div className="rounded-2xl border border-amanah/20 bg-amanah/5 p-4 shadow-sm">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-amanah/10 text-amanah">
            <Headphones className="h-4.5 w-4.5" />
          </div>
          <p className="mt-3 text-sm font-semibold text-foreground">
            Need help?
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Our support team is here for you.
          </p>
          <Link
            href="#"
            className="mt-3 inline-flex w-full items-center justify-center rounded-lg border border-amanah/25 bg-background px-3 py-2 text-xs font-medium text-amanah transition-colors hover:bg-amanah/10"
          >
            Contact Support
          </Link>
        </div>
      </div>
    </aside>
  );
}
