# Client de jeu et mises à jour

## Importer son client

Le dépôt ne contient pas l’installation d’un joueur ni de compte réel. Fournir une installation compatible contenant :

```text
resources/app/retroclient/Abrak.exe
resources/app/retroclient/loader.swf
resources/app/retroclient/config.xml
```

Après `npm run setup` :

```powershell
npm run import:client -- --from "C:/Games/MonClient"
```

Le script lit le client source et crée une copie dans `client/Abrak/Retro/`. Il refuse une destination déjà présente, exclut les profils/caches connus et vérifie les octets copiés. Il crée le manifeste local et le reçu d’importation. Ces fichiers et la configuration effective sont ignorés par Git.

Une interruption de copie peut laisser une destination partielle à inspecter ; le script ne la remplace pas automatiquement.

## Relier son propre serveur

Le serveur de jeu est à fournir séparément. Cette distribution ne contient aucun émulateur, export MySQL, compte de jeu réel ni connecteur SQL privé. Le backend du launcher crée une base SQLite locale à partir de comptes fictifs de démonstration.

Importer son client avec la commande décrite plus haut, puis adapter les paramètres réseau de cette copie à son propre serveur. `desktop/client-config.example.json` décrit notamment l’exécutable du client, son dossier de travail et le mode de connexion manuelle. La configuration effective reste locale et exclue de Git.

Les fonctions de recherche, d’administration et de démonstration du launcher restent disponibles sans serveur de jeu. Pour une intégration de production, fournir séparément un adaptateur authentifié pour les comptes, personnages, tickets de connexion et livraisons. Les opérations de démonstration ne modifient aucune base de jeu.

## Préparer une mise à jour du client

Fermer le client de cette copie. Modifier uniquement les fichiers dans `client/Abrak/Retro/`, puis choisir une version entière supérieure à la version active. La version intégrée commence à 1 ; utiliser 2 pour la première publication.

```powershell
python tools/publish-client.py plan --version 2
python tools/publish-client.py publish --version 2
python tools/publish-client.py verify --version 2
python tools/publish-client.py activate --version 2
```

`plan` présente les fichiers et exclusions sans activer de version. `publish` crée un instantané immuable, un ZIP et son manifeste. `verify` compare les fichiers et l’archive aux empreintes attendues. `activate` change le pointeur de version après vérification. On peut aussi utiliser `publish --version 2 --activate`.

Les instantanés sont dans `releases/snapshots/<version>/`. Les données locales restent dans `data/` ; aucun de ces dossiers ne va dans GitHub.

## Ce que lit le launcher

- `/launcher/v2/main/versions.json` : version active.
- `/launcher/v2/main/fullclient/win/remastered.json` : manifeste des fichiers.
- `/launcher/v2/main/fullclient/win/remastered.zip` : archive complète.
- `/local/releases/<version>/files/<chemin>` : fichiers d’un instantané versionné.

Le runtime vérifie taille et empreinte, détecte les fichiers altérés, contrôle les chemins et refuse les écritures hors de la copie. Les anciennes versions restent disponibles tant que leurs instantanés sont conservés.

## Retour à une version publiée

```powershell
python tools/publish-client.py verify --version 2
python tools/publish-client.py activate --version 2
```

Remplacer 2 par le numéro de l’instantané à réactiver. La publication suivante doit utiliser un nouveau numéro libre ; un instantané existant n’est pas écrasé.

## Mise à jour du launcher lui-même

Ces commandes publient les fichiers du **client de jeu**. Après une modification des scripts ou de l’interface du launcher, exécuter à nouveau `npm run build`.

Un installateur signé, un hébergement public et une chaîne de mise à jour automatique du launcher ne sont pas fournis. Les paiements, votes et services externes de la démonstration ne deviennent pas des intégrations de production en déplaçant simplement ce dossier sur un hébergeur.
