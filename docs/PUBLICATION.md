# Publier sur GitHub

## Contenu préparé

Le dépôt contient les sources, les catalogues, les images, les guides et les captures. Les dépendances et exécutables sont reconstruits avec npm.

Les profils, comptes réels, bases SQLite/MySQL, installations de jeu, journaux, rapports de travail et configurations privées sont exclus. Les identifiants en `.test` du README appartiennent uniquement à la démonstration.

Les exports SQL, sauvegardes de bases, sources Java/Kotlin du serveur et connecteurs privés sont également refusés par le contrôle de publication, même lorsqu’ils sont ajoutés de force à Git. La base SQLite du launcher est générée sur la machine de l’utilisateur ; aucun fichier de base n’est distribué.

Le modèle `docs/verification-workflow.yml.example` permet de configurer facultativement GitHub Actions en le copiant dans `.github/workflows/verify.yml` sur son propre dépôt. Les mêmes commandes de vérification sont disponibles localement.

## Contrôler avant un envoi

```powershell
npm run check:publication
git status --short
git ls-files
```

Le contrôle inspecte les fichiers suivis et les nouveaux fichiers non ignorés. Il refuse les répertoires privés, clés privées, chemins de profils personnels, résidus de l’environnement de travail et fichiers de source trop volumineux. Il signale les littéraux de type identifiant secret qui nécessitent une revue. Les fichiers déjà suivis sont aussi vérifiés, même si une règle `.gitignore` les masquerait normalement.

Ne pas utiliser `git add -f` pour inclure les données ignorées. La base locale et le client de jeu ne doivent pas être ajoutés au dépôt.

## Créer une archive propre

```powershell
npm run package:source
```

Le script exécute les contrôles, archive exactement l’inventaire Git publiable puis vérifie le CRC de l’archive. Il écrit `AbrakLauncher-GitHub.zip` et son fichier SHA-256 à côté du dossier du projet. L’archive ne contient ni l’historique Git ni les fichiers ignorés.

## Premier envoi

Le dépôt de référence est [KiraShironaga/Abrak-Uplauncher](https://github.com/KiraShironaga/Abrak-Uplauncher). Après extraction de l’archive ZIP, initialiser d’abord une branche `main` avec `git init --initial-branch=main`. Pour publier sa propre copie, créer un dépôt vide sur son compte GitHub, puis remplacer `OWNER/REPO` ci-dessous.

Pour ne pas publier son adresse personnelle dans les commits, configurer **localement dans ce dépôt** l’adresse `noreply` affichée par GitHub dans les paramètres de messagerie. Vérifier aussi le nom d’auteur choisi avant le premier commit.

```powershell
git add .
git diff --cached --stat
npm run check:publication
git commit -m "Initial release"
git remote add origin https://github.com/OWNER/REPO.git
git push -u origin main
```

Ces commandes d’envoi sont à lancer après revue du contenu et des droits sur les éléments tiers. Aucun dépôt distant, compte GitHub ou secret d’accès n’est nécessaire pour compiler localement.
