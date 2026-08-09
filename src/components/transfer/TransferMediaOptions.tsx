// Traitement des médias transférés. Mêmes questions et mêmes garde-fous que l'éditeur de profil
// d'export (moteur, vitesse, codec, codec audio, conteneur) : la cascade partagée vaut ici aussi,
// on ne réécrit ni les couples valides ni les moteurs sondés. Le catalogue y est seulement réduit à
// ce que les logiciels de montage importent (cf. transferEncoding).
import { useTranslation } from "react-i18next";
import { FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectGroupLabel, SelectItem,
} from "@/components/ui/select";
import { Section, Row } from "@/components/ae/aeShared";
import { useExportEncodingFields } from "@/features/export/encodingFields";
import {
  EXPORT_SPEED_OPTIONS, getExportCodecLabel,
  type ExportAudioMode, type ExportCodec, type ExportContainer, type ExportEncoderMode, type ExportSpeed,
} from "@/features/export/profiles";
import { basename } from "@/lib/utils";
import type { TransferMediaMode } from "@/lib/bridge";
import { NLE_AUDIO, NLE_CODECS, NLE_CONTAINERS, keepAllowed } from "./transferEncoding";
import type { TransferCtl } from "./useTransfer";

const MEDIA_MODES: TransferMediaMode[] = ["copy", "remux", "reencode"];

export function TransferMediaOptions({ ctl }: { ctl: TransferCtl }) {
  const { t } = useTranslation("transfer");
  // Les libellés des lignes d'encodage viennent du namespace « export » : ce sont les MÊMES
  // réglages que l'éditeur de profil, les traduire deux fois les ferait diverger.
  const { t: tExport } = useTranslation("export");
  const {
    mediaMode, setMediaMode, codec, audioMode, container, encoderMode, speed, applyEncoding,
    outDir, chooseOut, producesFiles, needsDir, busy,
  } = ctl;

  const fields = useExportEncodingFields(
    { codec, container, audioMode, encoderMode, speed },
    applyEncoding,
    { allowedCodecs: NLE_CODECS },
  );

  const encode = mediaMode === "reencode";
  const file = mediaMode !== "copy";
  // Ré-encoder le son n'a de sens qu'en ré-encodage vidéo ; ailleurs la piste est recopiée telle quelle.
  const audioSettable = encode;
  const speedSettable = encode && fields.speedSettable;

  const audioGroups = keepAllowed(fields.audioGroups, NLE_AUDIO);
  const audioLone = fields.audioLoneOptions.filter((o) => NLE_AUDIO.has(o.value));
  const containerOptions = fields.containerOptions.filter((o) => NLE_CONTAINERS.has(o.value));

  return (
    <>
      <Section title={t("sections.media")}>
        <ToggleGroup
          value={[mediaMode]}
          onValueChange={(v) => { const next = v[0] as TransferMediaMode | undefined; if (next) setMediaMode(next); }}
          disabled={busy}
        >
          {MEDIA_MODES.map((m) => (
            <ToggleGroupItem key={m} value={m} className="flex-1">{t(`mediaModes.${m}.label`)}</ToggleGroupItem>
          ))}
        </ToggleGroup>
        <p className="text-[11px] text-muted-foreground">{t(`mediaModes.${mediaMode}.hint`)}</p>
      </Section>

      {/* Lignes toujours présentes, grisées hors de leur flux : l'UI ne saute pas quand on change de mode. */}
      <Section title={t("sections.encoding")}>
        <Row label={tExport("editor.optimization")} disabled={!encode}>
          <Select
            value={encoderMode}
            onValueChange={(v) => fields.pickEncoderMode(v as ExportEncoderMode)}
            items={fields.encoderItems}
            disabled={busy || !encode}
          >
            <SelectTrigger className="w-[58%]">
              <SelectValue>{fields.encoderItems.find((i) => i.value === encoderMode)?.label}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {fields.encoderItems.map((i) => <SelectItem key={i.value} value={i.value}>{i.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </Row>

        <Row label={tExport("editor.speed")} disabled={!speedSettable}>
          <Select
            value={speed}
            onValueChange={(v) => applyEncoding({ speed: v as ExportSpeed })}
            items={EXPORT_SPEED_OPTIONS}
            disabled={busy || !speedSettable}
          >
            <SelectTrigger className="w-[58%]">
              <SelectValue>{EXPORT_SPEED_OPTIONS.find((o) => o.value === speed)?.label}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {EXPORT_SPEED_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </Row>

        <Row label={tExport("editor.codec")} disabled={!encode}>
          <Select
            value={codec}
            onValueChange={(v) => fields.pickCodec(v as ExportCodec)}
            items={fields.codecOptions}
            disabled={busy || !encode}
          >
            <SelectTrigger className="w-[58%]"><SelectValue>{getExportCodecLabel(codec)}</SelectValue></SelectTrigger>
            <SelectContent>
              {fields.codecGroups.map((g) => (
                <SelectGroup key={g.key}>
                  <SelectGroupLabel>{g.label}</SelectGroupLabel>
                  {g.options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        </Row>

        <Row label={tExport("editor.audioCodec")} disabled={!audioSettable}>
          <Select
            value={audioMode}
            onValueChange={(v) => applyEncoding({ audioMode: v as ExportAudioMode })}
            items={[...audioLone, ...audioGroups.flatMap((g) => g.options)]}
            disabled={busy || !audioSettable}
          >
            <SelectTrigger className="w-[58%]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {audioLone.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
              {audioGroups.map((g) => (
                <SelectGroup key={g.family}>
                  <SelectGroupLabel>{g.label}</SelectGroupLabel>
                  {g.options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        </Row>

        <Row label={tExport("editor.container")} disabled={!file}>
          <Select
            value={container}
            onValueChange={(v) => fields.pickContainer(v as ExportContainer)}
            items={containerOptions}
            disabled={busy || !file}
          >
            <SelectTrigger className="w-[58%]"><SelectValue>{container.toUpperCase()}</SelectValue></SelectTrigger>
            <SelectContent>
              {containerOptions.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </Row>
      </Section>

      {producesFiles && (
        <Section title={t("sections.outDir")}>
          <Row label={outDir ? basename(outDir) : t("form.none")}>
            <Button variant={needsDir ? "destructive" : "outline"} size="sm" onClick={chooseOut} disabled={busy}>
              <FolderOpen className="size-4" /> {t("form.choose")}
            </Button>
          </Row>
        </Section>
      )}
    </>
  );
}
