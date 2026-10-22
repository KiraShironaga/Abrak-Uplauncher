# Adapter le launcher à son serveur

Ce dépôt fournit le launcher et un backend de démonstration. **Aucun émulateur, base de jeu, compte réel ou connecteur MySQL privé n’est inclus.** La base SQLite créée au démarrage contient uniquement les données de démonstration du launcher.

Chaque émulateur possède son propre schéma de BDD et ses propres mécanismes de connexion. Il faut donc adapter le projet à son installation avant de l’utiliser avec de vrais joueurs.

## 1. Installer et importer son client

Suivre le [guide de compilation](COMPILATION.md), puis importer une copie de son client :

```powershell
npm run import:client -- --from "C:/Games/MonClient"
```

Adapter ensuite `desktop/client-config.json` et la configuration réseau du client importé aux adresses et ports de son serveur. Le fichier `desktop/client-config.example.json` sert de référence. La configuration effective reste locale et ignorée par Git.

## 2. Écrire son connecteur côté backend

Créer son module, par exemple `backend/modules/game-adapter.mjs`, puis le raccorder dans `backend/server.mjs`. Le frontend communique avec le backend du launcher ; les accès à la BDD du jeu et à l’émulateur doivent rester côté serveur.

| Partie à adapter | Fichier de départ | Ce qu’il faut relier |
| --- | --- | --- |
| Comptes et connexion | `backend/auth.mjs` | Comptes web et comptes de jeu, format des mots de passe, droits et sessions |
| Personnages et données du jeu | `backend/modules/world.mjs` | Personnages, serveurs, classements et données propres à son émulateur |
| Boutique, inventaire et monnaies | `backend/modules/commerce.mjs` | Livraisons d’objets, soldes, abonnements et confirmations du serveur |
| Connexion automatique du client | `desktop/native-services.cjs` et la route de ticket dans `backend/server.mjs` | Ticket court et à usage unique, validé par son serveur Login |

Les comptes fictifs de la démonstration ne deviennent pas automatiquement des comptes de jeu. Le ticket de connexion automatique est volontairement indisponible tant que son propre connecteur n’est pas implémenté.

## 3. Mapper sa propre BDD

Identifier ses tables et colonnes de comptes, personnages, objets et monnaies, puis écrire les correspondances dans son connecteur. Adapter aussi le hachage des mots de passe, les identifiants de serveurs et les rôles d’administration. Changer uniquement le nom de la BDD ou son port ne suffit pas.

Conserver les identifiants SQL dans des variables d’environnement ou un fichier local ignoré par Git. Utiliser des requêtes paramétrées et un compte SQL limité aux opérations nécessaires. Ne jamais intégrer les identifiants SQL dans le frontend, le client distribué, les captures ou le dépôt.

Pour modifier les objets ou monnaies d’un personnage connecté, passer par l’API ou les commandes de son émulateur afin de respecter son état en mémoire et sa sauvegarde. Le launcher ne doit confirmer une livraison qu’après la confirmation du serveur.

## 4. Tester sur une copie

Tester sur une BDD et un serveur isolés : connexion, droits joueur/admin, liste des personnages, achat, livraison, reconnexion et sauvegarde. Vérifier qu’une même demande ne peut pas livrer ou débiter deux fois.

```powershell
npm test
npm run verify
npm run check:publication
```

Ces commandes vérifient la démonstration et la publication ; elles ne prouvent pas que son adaptateur fonctionne avec son émulateur. Les tests en jeu doivent être réalisés séparément.

## 5. Distribuer le client et ses mises à jour

Une fois le raccordement validé, suivre le [guide client et mises à jour](CLIENT-ET-MISES-A-JOUR.md). Distribuer les fichiers du client et les réglages publics nécessaires, en conservant les sources de l’émulateur, les exports de BDD et les secrets hors du dépôt.
