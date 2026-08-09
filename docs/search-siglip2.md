# SigLIP 2 — Module de recherche NetsuRush

> Modèle, pipeline et choix réels du projet ([`python/search.py`](../python/search.py)) **+** catalogue complet des capacités de SigLIP 2 et des fonctionnalités possibles pour NetsuRush.

---

## 1. Modèle utilisé

`google/siglip2-so400m-patch16-naflex` (override hors-ligne via `NETSURUSH_SIGLIP_DIR` ou `NETSURUSH_SIGLIP_MODEL`).

- **So400m** (400 M params) : meilleur rapport qualité/vitesse, tient sur GPU.
- **naflex** : préserve l'**aspect ratio natif** → essentiel pour des rush 16:9 (un modèle carré écraserait l'image et dégraderait le matching).
- **Multilingue (109 langues)** : requêtes en **français** natives (texte passé en lowercase avant encodage).
- Embeddings **1152-dim**, **L2-normalisés à l'écriture** → similarité cosinus = simple produit scalaire.

Encodage GPU si dispo (autocast fp16), sinon CPU. Forçable via `NETSURUSH_SIGLIP_DEVICE`.

### Ce que la release expose réellement (important)

Les checkpoints publiés sont **les deux tours d'encodage** (vision + texte). Tout ce qui est *génératif* (légendes, bounding boxes) vient du **décodeur LocCa** et du **teacher de self-distillation**, utilisés **à l'entraînement seulement** — **pas livrés** dans le checkpoint d'inférence.

Conséquence : SigLIP 2 **seul** sait *mesurer* (embeddings, similarité, scores), **pas générer** de texte. Pour de la génération (décrire un plan en phrase), il faut un **VLM construit sur SigLIP 2** (ex. PaliGemma 2). Cf. § capacités tier C.

---

## 2. Pipeline actuel

```
detect.py (TransNetV2, précision Max, seuil 0.2)  →  plans
  → échantillonnage ADAPTATIF : 3 frames/plan (25/50/75 %) via ffmpeg (seek keyframe, timeout 6 s/frame)
    spread = 1 − min(cos entre frames) → statique (<0.10) : frame centrale ; mouvement : mean-pool re-normalisé
  → embed → L2-normalise → cache SQLite  frame_embeddings_v1  (+ vignette JPEG 320px)  [1 vecteur/plan]
requête texte → nrsearch/qtext (nettoyage, langue, VUES de prompt) → embed en 1 forward → moyenne pondérée re-normalisée
  + réfs (images+plans) / négatif → cosine vs index → calibrage sigmoïde → top-k
  @perso → pool visages remappé sur la grille de plans → classement fusionné action + confiance d'identité
```

Commandes : `index <video>` · `search {text,neg_text,lang,refs,char_ids,top_k,min_score,beta,aesthetic}` · `dedup {scenes|file_path,threshold}` · `cluster {scenes|file_path,k}` · `query`/`query-image` (compat, reroutés vers `search`) · `status` · `indexed`.
Mode `serve` = daemon : modèle chargé **une fois**, protocole ligne-JSON stdin/stdout, progression sur stderr (`PHASE:` / `STAGE:load` / `STAGE:infer` / `STAGE:prog:i/n`).

Cache : table `frame_embeddings_v1` dans `~/.netsurush/netsurush.db`, PK `(file_path, model, scene_index)`. Vignette stockée à l'indexation → résultats affichés sans re-seek ffmpeg.

---

## 3. Backend de recherche

- **Brute-force** (défaut) : matrice `(N, 1152)` en RAM, `mat @ requête` (BLAS). **Exact**, millisecondes sur des milliers de plans.
- **FAISS IVFPQ** (fallback) : index compressé, bascule **automatique** quand la matrice brute dépasserait le budget RAM. Seuil RAM-piloté = `RAM × NETSURUSH_RAM_FRACTION / (dim×4)` → ~**1,7 M de plans** avec 16 Go. En dessous = brute-force exact ; au-delà = recherche **approchée**. Persisté disque, resync paresseuse avec SQLite. Si `faiss-cpu` absent → brute-force.
- Raison d'être : cas « énormément de rush » (DB globale qui s'accumule). En usage normal, **jamais déclenché**.

---

## 4. Toutes les capacités de SigLIP 2

Classées par **disponibilité réelle**. Tier A = ce que `search.py` peut faire dès maintenant (encodeur seul). Tier B = + une petite tête entraînée. Tier C = nécessite un VLM bâti sur SigLIP 2.

### Tier A — directement disponible (encodeur seul, zéro entraînement)

| Capacité | Comment | Application NetsuRush |
|----------|---------|----------------------|
| **Text → image** (retrieval) | embed texte, cosine vs frames | barre de recherche « plan de nuit sous la pluie » (cœur, déjà fait) |
| **Image → image** (similarité) | embed une frame/image, cosine vs index | « trouver des plans similaires » à partir d'un plan ou d'une image glissée |
| **Zero-shot classification** | comparer une frame à une liste de labels textuels arbitraires | **tags auto** : int/ext, jour/nuit, gros plan/large, présence visage, présence texte, type de plan |
| **Multilingue (109 langues)** | la tour texte encode FR/EN/JP… | requêtes FR natives ; recherche sur rush japonais via mots-clés FR |
| **Scoring sémantique calibré** | `sigmoid(cos·eˢᶜᵃˡᵉ + bias)` (`logit_scale`/`logit_bias`) | **seuil de pertinence** lisible (slider « > X % ») |
| **Clustering** | k-means / agglomératif sur les embeddings | grouper automatiquement les plans par scène/ambiance ; vue « moodboard » |
| **Déduplication** | cosine très élevé entre embeddings (SigLIP = meilleur en détection de doublons) | repérer les **prises multiples / plans quasi-identiques**, proposer la meilleure |
| **Recherche par exemple multiple** | moyenne (renormalisée) de plusieurs images de référence | requête « comme ces 3 plans » (moodboard → résultats) |
| **Requête négative** | soustraction de vecteurs | « plages **sans** personne » |
| **Ranking par concept** | projeter sur l'axe d'un concept texte | trier par « plus lumineux », « plus chargé », « plus gros plan » |
| **Patch features (dense)** | sortie non-poolée de la tour vision (`last_hidden_state`) | base pour les capacités spatiales du tier B |

### Tier B — avec une petite tête entraînée (linear probe / DPT decoder)

Les embeddings (globaux **ou** par patch) sont d'excellentes features de transfert : une couche linéaire ou un décodeur léger suffit (peu de données).

| Capacité | Comment | Application NetsuRush |
|----------|---------|----------------------|
| **Localisation / open-vocabulary** | refer. expression comprehension : SigLIP 2 surpasse nettement CLIP/SigLIP | « plan avec une voiture à gauche », surligner *où* dans la frame |
| **Segmentation sémantique** | DPT decoder sur patch features | masque de zones (ciel/personnage/décor) pour filtres avancés |
| **Estimation de profondeur / normales** | DPT decoder (bat les encodeurs CLIP-style) | tri « plans avec forte profondeur de champ » ; détection plan large vs serré objectif |
| **Classifieur de style perso** | linear probe sur quelques exemples étiquetés | « mes plans façon X », détection charte/look récurrent |
| **Score esthétique / qualité** | linear probe ou zero-shot « a high quality / sharp photo » | classer les meilleures prises, repérer flou/sous-ex |

### Tier C — via un VLM bâti sur SigLIP 2 (génération)

SigLIP 2 sert de **backbone vision** (il surpasse les ViT précédents dans PaliGemma 2 / LLaVA pour VQA et instruction-following). La génération demande le LLM décodeur, pas l'encodeur seul.

| Capacité | Comment | Application NetsuRush |
|----------|---------|----------------------|
| **Légende automatique de plan** | PaliGemma 2 (vision = SigLIP 2) | description texte par plan → recherche full-text + accessibilité |
| **VQA / chat sur les rush** | VLM | module « chat IA » : « combien de plans en extérieur ? », « trouve le plan où… » |
| **Grounded captioning / detection** | VLM avec sortie bbox | détection d'objets nommés, métadonnées riches par plan |

> Tiers A et B tournent **dans ton `.venv` actuel** (transformers + torch). Le tier C ajoute un VLM (poids plus lourds) — module futur, pas pour tout de suite.

---

## 5. Possibilités de fonctionnalités pour NetsuRush

Regroupées par effort. Toutes s'appuient sur le pipeline existant (1 vecteur/plan en cache).

**Implémenté (tier A + score esthétique)**
- Recherche texte → plans.
- « Trouver similaires » (image→image) au clic sur un plan (requête par embedding stocké, instantané).
- Recherche par image glissée dans le panneau (drag d'une référence externe) ou choisie au fichier.
- Requête multi-exemples (moodboard) : N réfs mean-poolées re-normalisées (1 réf = image→image, N = moodboard).
- Requête négative : classement `cos(pos) − β·cos(neg)` (β≈0.4, exact en brute-force ; vecteur fusionné en FAISS).
- Seuil de pertinence calibré (sigmoïde SigLIP) → slider « ≥ X % » (filtre à l'affichage, sans re-requête).
- Déduplication / prises quasi-identiques : union-find sur cosinus ≥ seuil (ancre = plan le plus central).
- Clustering par ambiance : k-means cosinus, k auto par silhouette (vue « Groupes »).
- Score esthétique / netteté (Tier B zero-shot, sans entraînement) : `cos(net) − cos(flou)` → tri « Qualité » + badge flou.
- Échantillonnage **adaptatif de frames** (cf. § 7) — actif à l'indexation.
- Compréhension de la requête : nettoyage, langue, ensembling de prompts multilingue (cf. § 7).
- Filtre `@personnage` : cadrage ouvert (décor/action/émotion), tri fusionné action + identité, combinaison de plusieurs mentions.

**Restant (tier A avancé / restructuration)**
- Tags auto + facettes via zero-shot (int/ext, jour/nuit, cadrage, visage, texte) — décision produit en attente.
- Recherche temporelle « moment précis » (multi-vecteur par plan → saut au timestamp).

**Avancé (tier B/C entraîné, modules futurs)**
- Localisation spatiale (« objet à gauche ») + surlignage dans la frame.
- Classifieur de style personnel (linear probe).
- Légendes auto + recherche full-text (PaliGemma 2).
- Chat IA / VQA sur les rush.

---

## 6. Résolution / texte à l'écran

`max_num_patches` au défaut (256) : suffisant pour le matching sémantique. Le **texte incrusté** ne matche que s'il est gros (titres, cartons pleine largeur) ; petit texte / sous-titres illisibles à cette résolution. Une vraie recherche OCR fine impliquerait de ré-indexer à `max_num_patches` plus élevé (+RAM/+temps) — non fait, peu utile.

---

## 7. Précision : compréhension de la requête, échantillonnage adaptatif, score calibré

- **Compréhension de la requête** (`nrsearch/qtext.py`, pur, testé `test/test_search_query.py`). Le modèle ne voit qu'une phrase : sa formulation pèse autant que son contenu, et deux façons de décrire le même plan donnaient deux classements. La requête est donc **nettoyée** (jetons `@` non résolus retirés — les chercher comme des mots ordinaires faussait tout), sa **langue détectée** (écriture, puis mots-outils, repli = langue de l'interface envoyée par le renderer), puis déclinée en **vues** : la requête nue (poids 1) + deux cadrages type légende **écrits dans SA langue** (poids 0,5). Les vues sont embeddées **en un seul forward** (`model.embed_texts`) puis moyennées et re-normalisées — ensembling de prompts, comme en zero-shot CLIP (poids des cadrages : `NETSURUSH_QUERY_TEMPLATE_WEIGHT`, 0 = requête nue seule). Un cadrage écrit dans une autre langue que la requête mélangeait deux langues dans le même vecteur : les cadrages existent donc dans les 6 langues de l'interface.
- **Requête posée sur un `@perso`.** Le cadrage parle d'un **personnage**, sans préjuger d'une action : décor, tenue, émotion, cadrage et action passent par le même chemin. Le sujet redondant en tête (« elle est en train de… ») est retiré — le pool est déjà filtré sur l'identité, le pronom ne fait que déplacer le vecteur.
- **Tri d'un `@perso` = action + identité.** Une description courte sépare mal les plans d'un même personnage (tous les cosinus se tiennent) : les deux signaux sont **centrés-réduits** puis additionnés (`IDENTITY_WEIGHT`, défaut 0,25, env `NETSURUSH_IDENTITY_WEIGHT`). À action comparable, le plan où le visage est reconnu avec certitude passe devant ; une action franche l'emporte toujours. Le score affiché suit ce classement (relatif au lot) — sinon le badge contredirait l'ordre des cartes. Le seuil de pertinence, lui, reste évalué sur le cosinus d'action calibré.
- **Plusieurs `@perso`.** Intersection des pools ; la confiance d'un plan est la **plus faible** des reconnaissances qui le retiennent (un plan où A est certain et B limite n'est pas un bon plan « A et B »). Intersection vide → on rend les plans réunissant le plus grand nombre de persos cités, en le signalant (`notice`) plutôt qu'une erreur sèche.

- **Échantillonnage adaptatif de frames** (à l'indexation). Détection de mouvement en **espace embedding** : 3 frames à 25/50/75 %, `spread = 1 − min(cos entre frames)`.
  - plan statique (`spread < STATIC_THR`, 0.10) → garde la **frame centrale** ;
  - plan avec mouvement → **mean-pool** des frames lues, **re-normalisé L2**.

  Schéma inchangé (1 vecteur/plan). Détection en espace embedding (≠ diff pixel) → robuste au grain/flicker de l'anime. Évite l'embedding « bâtard » d'un mean-pool aveugle sur un plan qui bouge. Coût : ~2-3× le temps d'indexation (3 grabs ffmpeg/plan). Marqueur `index_runs_v1.sampling` = `adaptive` ; les clips indexés en 1-frame (`legacy`) restent valides et sont **ré-indexables** via « Forcer » dans le picker.

- **Seuil de pertinence calibré.** `prob = sigmoid(cos × eˡᵒᵍⁱᵗ_ˢᶜᵃˡᵉ + logit_bias)` (`logit_scale`/`logit_bias` extraits du modèle au chargement). Score renvoyé = ce `prob` (0-1) → slider « n'afficher que ≥ X % ». Monotone → ne change pas le classement, juste le rend lisible. Pas de ré-index : conversion au vol sur les top-k. Absents → repli sur le cosinus brut.

---

## 8. Limites connues

- **Encodeur seul** : pas de génération de texte/bbox (cf. § 1) ; les capacités tier C nécessitent un VLM séparé.
- **Pan extrême** (contenu très différent dans un même plan) : même le mean-pool reste flou → nécessiterait du **multi-vecteur** (N vecteurs/plan, max au query). Non fait.
- **Calibration text-image** : `logit_scale`/`logit_bias` sont appris sur des paires texte-image. Le % affiché pour l'image→image et la requête négative réutilise cette même transformation (monotone, lisible) sans re-calibration sur paires image-image — baseline correcte, pas optimale.
- **OCR petit texte** : illisible au `max_num_patches` par défaut.
- **Langue de la requête** : le modèle est multilingue mais reste plus fort en anglais ; les cadrages sont écrits dans la langue détectée, aucune traduction n'est faite (aucun traducteur hors ligne dans le venv).

---

## Sources

- [SigLIP 2 — paper (arXiv 2502.14786)](https://arxiv.org/abs/2502.14786) · [version HTML](https://arxiv.org/html/2502.14786v1)
- [HuggingFace — blog SigLIP 2](https://huggingface.co/blog/siglip2)
- [HuggingFace — doc transformers SigLIP2 (NaFlex, max_num_patches, logits)](https://huggingface.co/docs/transformers/model_doc/siglip2)
- [LearnOpenCV — SigLIP 2 (capacités, dense prediction)](https://learnopencv.com/siglip-2-deepminds-multilingual-vision-language-model/)
- [Elastic — multimodal search avec SigLIP 2 embeddings](https://www.elastic.co/search-labs/blog/multimodal-search-siglip-2-elasticsearch)
- [Papers Explained 320 — SigLIP 2 (LocCa, masked prediction, refexp)](https://ritvik19.medium.com/papers-explained-320-siglip-2-dba08ff09559)
