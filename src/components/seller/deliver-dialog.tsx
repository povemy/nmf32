"use client";
// Task 14-a / Task 11 seller POD — DeliverDialog: seller marks a shipped order
// delivered with optional proof-of-delivery photo + note.
// The photo is downscaled IN-BROWSER (canvas → ≤1280px JPEG data-URL) with a
// ~1.2MB guard matching the backend limit, previewed, removable, then POSTed
// to /api/store/orders/[id]/deliver {proof?, note?}.
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { apiSend } from "./ui-bits";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Camera, CheckCircle2, Loader2, Trash2 } from "lucide-react";

const PROOF_MAX_DIM = 1280;
const PROOF_MAX_BYTES = 1_200_000; // must match backend validateProofDataUrl (1.2MB)

/** Approximate decoded byte size of a data-URL (base64 → bytes). */
function approxBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  return comma < 0 ? dataUrl.length : Math.floor((dataUrl.length - comma - 1) * 0.75);
}

/** Read a File, downscale to ≤1280px on the longest side and encode JPEG. */
async function fileToCompressedDataUrl(file: File, maxDim = PROOF_MAX_DIM): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read the file"));
    reader.readAsDataURL(file);
  });

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error("Could not decode that image"));
    im.src = dataUrl;
  });

  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Your browser does not support image compression");
  ctx.drawImage(img, 0, 0, w, h);

  // Walk quality down until the payload fits the 1.2MB guard.
  for (const quality of [0.82, 0.62, 0.45]) {
    const out = canvas.toDataURL("image/jpeg", quality);
    if (approxBytes(out) <= PROOF_MAX_BYTES) return out;
  }
  throw new Error("Photo is too large even after compression — try a different image");
}

export default function DeliverDialog({
  open,
  onOpenChange,
  order,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  order: { id: string; orderNumber: string };
  onDone: () => void;
}) {
  const [proof, setProof] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [processing, setProcessing] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setProof(null);
      setNote("");
    }
  }, [open]);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("Please choose an image file (JPG/PNG)");
      return;
    }
    setProcessing(true);
    try {
      setProof(await fileToCompressedDataUrl(file));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not process the photo");
    } finally {
      setProcessing(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const submit = async () => {
    setBusy(true);
    try {
      await apiSend("POST", `/api/store/orders/${order.id}/deliver`, {
        proof: proof ?? undefined,
        note: note.trim() || undefined,
      });
      toast.success(`${order.orderNumber} marked delivered — buyer asked to confirm receipt`);
      onOpenChange(false);
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not mark the order delivered");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (busy ? undefined : onOpenChange(o))}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Mark delivered — {order.orderNumber}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3.5">
          <p className="text-xs text-muted-foreground">
            Attach an optional proof-of-delivery photo (parcel at the doorstep, signed slip…) — the buyer sees it on the
            shipment timeline. We compress it in your browser before upload.
          </p>

          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            aria-label="Delivery proof photo"
            onChange={(e) => void pick(e.target.files?.[0])}
          />

          {proof ? (
            <div className="space-y-2">
              <div className="relative overflow-hidden rounded-xl border">
                <img src={proof} alt="Delivery proof preview" className="max-h-56 w-full object-contain" />
              </div>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1.5 text-emerald-700">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Ready ({Math.round(approxBytes(proof) / 1024)} KB)
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="min-h-[44px] gap-1 px-3 text-rose-600"
                  onClick={() => setProof(null)}
                >
                  <Trash2 className="h-3.5 w-3.5" /> Remove
                </Button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={processing}
              className="flex min-h-[88px] w-full flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed p-4 text-muted-foreground transition-colors hover:bg-muted/50 disabled:opacity-60"
            >
              {processing ? (
                <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
              ) : (
                <Camera className="h-5 w-5" aria-hidden />
              )}
              <span className="text-sm font-medium text-foreground">
                {processing ? "Compressing photo…" : "Add delivery photo (optional)"}
              </span>
              <span className="text-xs">JPEG/PNG · auto-resized to ≤1280px</span>
            </button>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="deliver-note">Note (optional)</Label>
            <Textarea
              id="deliver-note"
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Left with the concierge at 2:15pm…"
            />
          </div>

          <Button
            onClick={submit}
            disabled={busy || processing}
            className="w-full min-h-[44px] gap-2 bg-brand-gradient-deep text-white hover:opacity-90"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Confirm delivery
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
