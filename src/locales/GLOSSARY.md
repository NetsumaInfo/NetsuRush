# NetsuRush — Glossaire de traduction (terminologie MÉTIER)

Logiciel de **derush / montage vidéo** pilotant DaVinci Resolve. Les traductions doivent employer le
vocabulaire du montage vidéo/VFX de CHAQUE langue, **jamais du littéral**. Ce glossaire est la
référence unique : tout agent traducteur DOIT l'appliquer pour la cohérence entre namespaces.

## Règles pour les traducteurs

1. **Préserver les tokens d'interpolation** `{{var}}` tels quels (ex. `{{count}}`, `{{host}}`).
2. **Préserver les clés de pluriel** `_one` / `_other` (règles i18next). Adapter le pluriel à la langue
   (ja/zh n'ont pas de pluriel morphologique → même forme, mais garder les deux clés).
3. **Ne jamais traduire** : noms propres, noms de modèles, formats, raccourcis clavier (`Espace`,
   `Ctrl+Z` → convention locale si usuelle, sinon garder), identifiants techniques.
4. **Ton** : concis, direct, registre logiciel pro (comme Resolve/Premiere localisés). Pas de
   familiarité excessive, pas de calque de l'anglais.
5. **Ponctuation** : garder `…` (points de suspension), `«      »`/guillemets adaptés à la langue cible
   (ja「」, zh 中文引号, de „“, es «» ou "", en "").

## Termes verrouillés

| FR (source) | EN | ES | DE | JA | ZH |
|---|---|---|---|---|---|
| rush (métrage source) | footage / clip | clip / metraje | Rohmaterial / Clip | 素材 / クリップ | 素材 |
| plan (unité de découpe) | shot | plano / toma | Einstellung / Shot | ショット / カット | 镜头 |
| derush (workflow) | logging | visionado / clasificación | Sichtung | 素材整理 | 素材整理 |
| flux (rushs enchaînés dans une grille) | flow | flujo | Abfolge | 連続表示 | 连续浏览 |
| découpe / coupe | cut | corte | Schnitt | カット | 剪切 / 切分 |
| découper (verbe) | to cut / split | cortar / dividir | schneiden | カットする | 切分 |
| timeline | timeline | timeline / línea de tiempo | Timeline | タイムライン | 时间线 |
| piste (audio/vidéo) | track | pista | Spur | トラック | 轨道 |
| plage (in/out) | range | rango / intervalo | Bereich | 範囲 | 范围 |
| vignette | thumbnail | miniatura | Miniatur | サムネイル | 缩略图 |
| aperçu | preview | vista previa | Vorschau | プレビュー | 预览 |
| proxy | proxy | proxy | Proxy | プロキシ | 代理文件 |
| matte | matte | matte | Matte | マット | 遮罩 |
| roto (rotoscopie) | roto | rotoscopía | Roto | ロト | 转描 |
| calque | layer | capa | Ebene | レイヤー | 图层 |
| masque | mask | máscara | Maske | マスク | 蒙版 |
| débruitage | denoise | reducción de ruido | Entrauschen | ノイズ除去 | 降噪 |
| upscale / agrandir | upscale | escalado / aumento de resolución | Hochskalieren | アップスケール | 超分辨率 |
| interpolation (RIFE) | interpolation | interpolación | Interpolation | 補間 | 插帧 |
| profondeur (depth) | depth | profundidad | Tiefe | 深度 | 深度 |
| hésitation (euh/hmm) | filler | muletilla | Füllwort | フィラー | 语气词 |
| silence | silence | silencio | Stille | 無音 | 静音 |
| préréglage | preset | preajuste | Voreinstellung | プリセット | 预设 |
| sous-titres | subtitles | subtítulos | Untertitel | 字幕 | 字幕 |
| dictée | dictation | dictado | Diktat | 音声入力 | 语音输入 |
| transcription | transcription | transcripción | Transkription | 文字起こし | 转录 |
| board / mood-board | board | tablero | Board | ボード | 画板 |
| cadre (sur le board) | frame | marco | Rahmen | フレーム | 边框 |
| note (adhésive) | note | nota | Notiz | ノート | 便签 |
| rogner | crop | recortar | zuschneiden | トリミング | 裁剪 |
| miroir (flip) | flip | voltear | spiegeln | 反転 | 翻转 |
| fondu | dissolve / fade | fundido | Blende | ディゾルブ | 溶解 |
| rendu | render | renderizado | Rendern | レンダリング | 渲染 |
| réencoder | re-encode | recodificar | neu kodieren | 再エンコード | 重新编码 |
| remux (copie des flux, sans réencodage) | Remux | Remux | Remux | Remux | Remux |
| lossless (sans perte) | lossless | sin pérdidas | verlustfrei | ロスレス | 无损 |
| IA | AI | IA | KI | AI | AI |
| dossier | folder | carpeta | Ordner | フォルダー | 文件夹 |
| collection | collection | colección | Sammlung | コレクション | 合集 |
| détacher (fenêtre) | detach | desacoplar | abdocken | 切り離す | 分离 |
| épingler | pin | fijar / anclar | anheften | ピン留め | 固定 |

## Ne PAS traduire (noms propres / produit / technique)

- **Produit / modules** : NetsuRush, NetsuLab, Derush *(comme titre d'onglet — garder ; en usage
  descriptif, employer le verbe local ci-dessus)*, Roto Studio.
- **Hôtes** : DaVinci Resolve, Resolve, Premiere Pro, After Effects, Fusion, Media Pool, Adobe.
- **Services** : Discord, Convex, YouTube, Hugging Face.
- **Modèles / moteurs** : SigLIP2, Real-ESRGAN, Real-CUGAN, TransNetV2, OmniShotCut, Whisper,
  WhisperX, Parakeet, Canary, Silero, NOVA-VAD, SAM2, MatAnyone, RIFE, Depth Anything, BiRefNet,
  YuNet, SFace, MiniMax, Wan, ArtCNN.
- **Formats / techno** : Remux, HEVC, H.264, mp4, mkv, SRT, VTT, FCPXML, ZXP, CEP, NVENC, ffmpeg, GPU, VRAM,
  RAM, FPS, ASR, VAD, HSB/RGB/hex.
