"use client";
// Stores & Domains admin view (stores table + aggregated domains table).
import { useMemo, useState } from "react";
import { Globe, Search } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiSend, useApi } from "./use-api";
import { EmptyState, ErrorState, PageHeader, StatusChip, TableSkeleton } from "./ui-bits";

type AdminStoreRow = {
  id: string;
  name: string;
  slug: string;
  status: string;
  seller?: { displayName: string; email: string } | null;
  sellerName?: string | null;
  productCount?: number;
  domainsCount?: number;
  domains?: AdminDomainRow[];
  _count?: { products?: number; domains?: number };
};

type AdminDomainRow = {
  id: string;
  domain: string;
  mode: string;
  status: string;
  sslStatus: string;
  errorReason?: string | null;
  isPrimary?: boolean;
  storeName?: string | null;
};

export function StoresView() {
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const url = useMemo(() => `/api/admin/stores${search ? `?search=${encodeURIComponent(search)}` : ""}`, [search]);
  const { data, error, loading, refetch } = useApi<AdminStoreRow[]>(url);
  const rows = data ?? [];
  const [verifying, setVerifying] = useState<string | null>(null);

  const domains: AdminDomainRow[] = useMemo(() => {
    const out: AdminDomainRow[] = [];
    for (const s of rows) {
      const list = s.domains ?? [];
      for (const d of list) out.push({ ...d, storeName: s.name });
    }
    return out;
  }, [rows]);

  const productsOf = (s: AdminStoreRow) => s.productCount ?? s._count?.products ?? 0;
  const domainsOf = (s: AdminStoreRow) => s.domainsCount ?? s._count?.domains ?? (s.domains?.length ?? 0);

  const retryDomain = async (d: AdminDomainRow) => {
    setVerifying(d.id);
    try {
      // Contract exposes domain verify on the seller surface; try an admin-flavoured
      // endpoint first and degrade gracefully if not implemented.
      await apiSend(`/api/admin/domains/${d.id}/verify`, "POST");
      toast.success("Domain re-verification triggered", { description: d.domain });
      void refetch();
    } catch (e) {
      toast.info("Domain re-verification unavailable", {
        description: e instanceof Error ? e.message : "This action may only be run from the seller portal.",
      });
    } finally {
      setVerifying(null);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader title="Stores & Domains" description="All tenant storefronts and their custom domains." />

      <Tabs defaultValue="stores">
        <TabsList className="h-auto">
          <TabsTrigger value="stores" className="min-h-[44px]">Stores ({rows.length})</TabsTrigger>
          <TabsTrigger value="domains" className="min-h-[44px]">Domains ({domains.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="stores" className="mt-4">
          <Card className="py-0">
            <CardContent className="p-4">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && setSearch(searchInput.trim())}
                  onBlur={() => setSearch(searchInput.trim())}
                  placeholder="Search stores…"
                  className="min-h-[44px] pl-9"
                  aria-label="Search stores"
                />
              </div>
              <div className="mt-4 overflow-x-auto">
                {error ? (
                  <ErrorState message={error} onRetry={() => void refetch()} />
                ) : loading ? (
                  <TableSkeleton rows={6} cols={5} />
                ) : rows.length === 0 ? (
                  <EmptyState title="No stores found" />
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Store</TableHead>
                        <TableHead className="hidden md:table-cell">Slug</TableHead>
                        <TableHead>Seller</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Products</TableHead>
                        <TableHead className="text-right">Domains</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((s) => (
                        <TableRow key={s.id}>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <Globe className="h-4 w-4 shrink-0 text-teal-600 dark:text-teal-400" />
                              <span className="font-medium">{s.name}</span>
                            </div>
                          </TableCell>
                          <TableCell className="hidden font-mono text-xs text-muted-foreground md:table-cell">{s.slug}</TableCell>
                          <TableCell className="text-sm">{s.seller?.displayName ?? s.sellerName ?? "—"}</TableCell>
                          <TableCell><StatusChip status={s.status} /></TableCell>
                          <TableCell className="text-right tabular-nums">{productsOf(s)}</TableCell>
                          <TableCell className="text-right tabular-nums">{domainsOf(s)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="domains" className="mt-4">
          <Card className="py-0">
            <CardContent className="p-4">
              <div className="overflow-x-auto">
                {error ? (
                  <ErrorState message={error} onRetry={() => void refetch()} />
                ) : loading ? (
                  <TableSkeleton rows={4} cols={6} />
                ) : domains.length === 0 ? (
                  <EmptyState
                    title="No domain data exposed"
                    hint="Domain details appear here once the admin stores payload includes them (seller portal manages DNS setup)."
                  />
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Domain</TableHead>
                        <TableHead className="hidden sm:table-cell">Store</TableHead>
                        <TableHead>Mode</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>SSL</TableHead>
                        <TableHead className="hidden lg:table-cell">Error</TableHead>
                        <TableHead className="text-right">Action</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {domains.map((d) => (
                        <TableRow key={d.id}>
                          <TableCell className="font-medium">
                            <span className="flex items-center gap-2">
                              {d.domain}
                              {d.isPrimary ? <Badge variant="outline" className="border-teal-200 bg-teal-50 text-teal-800 dark:border-teal-900 dark:bg-teal-950/60 dark:text-teal-300">primary</Badge> : null}
                            </span>
                          </TableCell>
                          <TableCell className="hidden text-sm sm:table-cell">{d.storeName ?? "—"}</TableCell>
                          <TableCell className="uppercase text-xs text-muted-foreground">{d.mode}</TableCell>
                          <TableCell><StatusChip status={d.status} /></TableCell>
                          <TableCell><StatusChip status={d.sslStatus} /></TableCell>
                          <TableCell className="hidden max-w-[220px] truncate text-xs text-red-600 lg:table-cell dark:text-red-400">{d.errorReason ?? "—"}</TableCell>
                          <TableCell className="text-right">
                            {d.status === "failed" || d.status === "pending" || d.status === "verifying" ? (
                              <Button size="sm" variant="outline" className="min-h-[44px] sm:min-h-0" disabled={verifying !== null} onClick={() => void retryDomain(d)}>
                                {verifying === d.id ? "Checking…" : "Re-check"}
                              </Button>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
