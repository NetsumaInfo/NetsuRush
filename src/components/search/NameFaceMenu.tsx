import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { UserPlus, ScanFace, Check } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { type CharRef } from "@/lib/bridge";
import { useApp } from "@/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";

// Menu « Nommer ce visage » : assigne le visage (ref) à un personnage existant, ou en crée un.
// Enregistre l'embedding comme échantillon du personnage → la recherche future le reconnaît.
export function NameFaceMenu({ refPayload, trigger, onDone }: {
  refPayload: CharRef; trigger: ReactElement; onDone?: (charId: number, name: string) => void;
}) {
  const { t } = useTranslation(["search", "common"]);
  const { characters, addSampleToCharacter, createCharacter } = useApp(useShallow((s) => ({
    characters: s.characters, addSampleToCharacter: s.addSampleToCharacter, createCharacter: s.createCharacter,
  })));
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function assign(charId: number, charName: string) {
    setBusy(true);
    let ok = false;
    try { ok = await addSampleToCharacter(charId, refPayload); }
    finally { setBusy(false); }
    if (ok) onDone?.(charId, charName);
  }
  async function createAndAssign() {
    const n = name.trim();
    if (!n) return;
    setBusy(true);
    let id: number | null = null;
    try {
      id = await createCharacter({ name: n });
      if (id != null) await addSampleToCharacter(id, refPayload);
    } finally { setBusy(false); setCreating(false); }
    if (id != null) onDone?.(id, n);
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={trigger} />
        <DropdownMenuContent align="end" className="max-h-72 w-56 overflow-y-auto">
          <DropdownMenuLabel>{t("nameFaceMenu.title")}</DropdownMenuLabel>
          {characters.map((c) => (
            <DropdownMenuItem key={c.id} onClick={() => assign(c.id, c.name)} className="gap-2">
              <span className="h-6 w-6 shrink-0 overflow-hidden rounded bg-muted">
                {c.avatar
                  ? <img src={c.avatar} alt="" className="h-full w-full object-cover" />
                  : <ScanFace className="h-4 w-4 m-1 text-muted-foreground" />}
              </span>
              <span className="truncate">{c.name}</span>
            </DropdownMenuItem>
          ))}
          {characters.length > 0 && <DropdownMenuSeparator />}
          <DropdownMenuItem onClick={() => { setName(""); setCreating(true); }} className="gap-2">
            <UserPlus className="h-4 w-4" /> {t("nameFaceMenu.newCharacter")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={creating} onOpenChange={(o) => { if (!o) setCreating(false); }}>
        <DialogContent className="max-w-sm">
          <DialogTitle>{t("nameFaceMenu.newCharacterTitle")}</DialogTitle>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("nameFaceMenu.namePlaceholder")}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) void createAndAssign(); }} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setCreating(false)}>{t("common:action.cancel")}</Button>
            <Button size="sm" disabled={!name.trim() || busy} onClick={createAndAssign}>
              {busy ? <Spinner className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />} {t("nameFaceMenu.createAndSave")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
