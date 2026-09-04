"use client";

import React, { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, ChevronDown, FileText, SwitchCamera } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * ActiveFilingSwitcher — visual refresh only. Every exported type, prop
 * name, and behavior (compact vs full variant, onSwitch contract) is
 * unchanged so existing call sites keep working untouched.
 */

export type FilingOption = {
  id: string;
  taxYear: number;
  status: string;
  taxpayerName: string | null;
};

type ActiveFilingSwitcherProps = {
  activeDraft: {
    id: string;
    taxYear: number;
    status: string;
    taxpayerName: string | null;
  } | null;
  allDrafts: FilingOption[];
  onSwitch: (draftId: string) => void;
  /** If true, show a compact version for the header */
  compact?: boolean;
};

function formatStatus(status: string) {
  return status.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function getStatusColor(status: string) {
  switch (status) {
    case "approved_for_filing":
    case "completed":
      return "border-amanah/30 bg-amanah/10 text-amanah";
    case "under_review":
    case "reconciliation_required":
    case "ready_for_approval":
      return "border-mizan/40 bg-mizan/20 text-mizan-foreground";
    default:
      return "border-border bg-background text-muted-foreground";
  }
}

export function ActiveFilingSwitcher({ activeDraft, allDrafts, onSwitch, compact = false }: ActiveFilingSwitcherProps) {
  const router = useRouter();
  const [switching, setSwitching] = useState(false);

  const handleSwitch = useCallback(
    async (draftId: string) => {
      if (draftId === activeDraft?.id) return;
      setSwitching(true);
      try {
        await onSwitch(draftId);
        router.refresh();
      } finally {
        setSwitching(false);
      }
    },
    [activeDraft?.id, onSwitch, router],
  );

  // Compact variant for the header bar
  if (compact) {
    if (!activeDraft) {
      return (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <FileText className="h-3.5 w-3.5" />
          <span>No filing selected</span>
        </div>
      );
    }

    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 rounded-full px-3 text-xs font-medium text-muted-foreground hover:bg-amanah/5 hover:text-amanah"
            disabled={switching}
          >
            {switching ? (
              <Skeleton className="h-3 w-24" />
            ) : (
              <>
                <FileText className="h-3.5 w-3.5 text-amanah" />
                <span className="hidden sm:inline">Tax Year {activeDraft.taxYear}</span>
                <span className="sm:hidden">TY {activeDraft.taxYear}</span>
                <ChevronDown className="h-3 w-3 opacity-50" />
              </>
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Switch filing</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {allDrafts.length === 0 ? (
            <DropdownMenuItem disabled className="text-xs text-muted-foreground">
              No other filings available
            </DropdownMenuItem>
          ) : (
            allDrafts.map((draft) => {
              const isActive = draft.id === activeDraft.id;
              return (
                <DropdownMenuItem key={draft.id} onClick={() => handleSwitch(draft.id)} disabled={isActive || switching} className="flex items-center justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm">
                      <span>Tax Year {draft.taxYear}</span>
                      {isActive && <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-amanah" />}
                    </div>
                    {draft.taxpayerName && <div className="truncate text-xs text-muted-foreground">{draft.taxpayerName}</div>}
                  </div>
                  <Badge variant="outline" className={`ml-2 shrink-0 text-[10px] px-1.5 py-0 ${getStatusColor(draft.status)}`}>
                    {formatStatus(draft.status)}
                  </Badge>
                </DropdownMenuItem>
              );
            })
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => router.push("/tax/new")} className="text-xs text-amanah">
            <SwitchCamera className="mr-2 h-3.5 w-3.5" />
            Manage filings
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  // Full variant for the sidebar
  if (!activeDraft) {
    return (
      <div className="rounded-xl border border-dashed border-border p-4 text-center">
        <FileText className="mx-auto h-5 w-5 text-muted-foreground" />
        <p className="mt-1 text-xs text-muted-foreground">No filing selected</p>
        <Button variant="outline" size="sm" className="mt-2 h-7 text-xs" onClick={() => router.push("/tax/new")}>
          Select a filing
        </Button>
      </div>
    );
  }

  return (
    <div className="rounded-xl border bg-card p-3 shadow-sm">
      <div className="flex items-center justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 shrink-0 text-amanah" />
            <span className="truncate text-sm font-medium">Tax Year {activeDraft.taxYear}</span>
          </div>
          {activeDraft.taxpayerName && <p className="mt-0.5 truncate text-xs text-muted-foreground">{activeDraft.taxpayerName}</p>}
          <Badge variant="outline" className={`mt-1 text-[10px] px-1.5 py-0 ${getStatusColor(activeDraft.status)}`}>
            {formatStatus(activeDraft.status)}
          </Badge>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" disabled={switching}>
              <ChevronDown className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Switch to filing</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {allDrafts.length === 0 ? (
              <DropdownMenuItem disabled className="text-xs text-muted-foreground">
                No other filings
              </DropdownMenuItem>
            ) : (
              allDrafts.map((draft) => {
                const isActive = draft.id === activeDraft.id;
                return (
                  <DropdownMenuItem key={draft.id} onClick={() => handleSwitch(draft.id)} disabled={isActive || switching}>
                    <div className="flex w-full items-center justify-between">
                      <span className="text-sm">TY {draft.taxYear}</span>
                      {isActive && <CheckCircle2 className="h-3.5 w-3.5 text-amanah" />}
                    </div>
                  </DropdownMenuItem>
                );
              })
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => router.push("/tax/new")} className="text-xs text-amanah">
              Manage filings
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
