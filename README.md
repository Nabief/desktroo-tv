# Desktroo TV

La TV en direct de bout en bout, en quatre écrans : l'app installe le moteur, règle les chaînes et le guide,
puis déclare le tout dans Jellyfin. Installée depuis Desktroo Apps, les apps de [Desktroo](https://desktroo.fr).

- **Moteur** : [Threadfin](https://github.com/Threadfin/Threadfin) (MIT), compilé depuis sa source à la version
  indiquée dans le `Dockerfile`, **sans modification**, lancé par l'app sur son port interne 34400. Sa licence est
  livrée dans l'image (`/app/THREADFIN-LICENSE`). Desktroo n'est ni affilié au projet Threadfin ni soutenu par lui.
- **Assistant** (`public/index.html`) : ① abonnement, ② chaînes, ③ guide, ④ Jellyfin, puis une page de vérification.
  Rien à saisir dans Threadfin : l'app le pilote par la même liaison que son interface web (`tf.js`, WebSocket maison,
  sans dépendance).
- **Abonnement** : l'app interroge le fournisseur (API Xtream, `player_api.php`) à partir de l'adresse de la liste, et
  affiche l'état, la date de fin et le nombre de connexions. Lien de réabonnement vers nabief.xyz.
- **Chaînes** : un filtre par groupe choisi, numérotés par milliers (1000, 2000…), avec les exclusions d'usage.
  Au choix : toutes les qualités (HD, SD, HEVC, 4K) ou la HD seule.
- **Guide** : source gratuite [xmltvfr.fr](https://xmltvfr.fr) par défaut (ou celle du fournisseur), puis association
  automatique par identifiant puis par nom, les versions d'une même chaîne reprenant la même association. Les chaînes
  sans programme reçoivent une grille de remplacement et restent visibles.
- **Jellyfin** : l'app ouvre une session administrateur, crée une clé d'accès à son nom, déclare le tuner
  (`http://dt-tv:34400`) et le guide (`/xmltv/threadfin.xml`), puis lance l'actualisation. Le mot de passe n'est pas
  enregistré ; seule la clé l'est, dans `/data/state.json`.
- **Réseau** : rien n'est ouvert sur le NAS. Jellyfin joint l'app par son nom de conteneur sur le réseau des apps.
- **Accès** : toute requête sans le secret posé par Desktroo est refusée (`/healthz` excepté). L'interface complète de
  Threadfin reste disponible sous `/engine/` pour les cas particuliers, derrière la même protection.

## Mettre à jour le moteur

Changer `THREADFIN_VERSION` dans le `Dockerfile` (une étiquette de https://github.com/Threadfin/Threadfin/tags),
puis publier une version de l'app.

## Essai local

```
node test/fake-provider.js &                  # faux fournisseur : liste, guide et état du compte
DESKTROO_APP_SECRET=zz DATA_DIR=/tmp/dt node server.js
curl -H X-Desktroo-Secret:zz -H X-Desktroo-User:moi localhost:8080/api/state
```

Le moteur doit être disponible en `/app/threadfin` (ou lancé à part sur le port 34400).

## Publier une version

`powershell -ExecutionPolicy Bypass -File publish-app.ps1 tv 1.0.0 "première version"` depuis le dépôt Desktroo,
après avoir ajouté l'app à la table `$APPS` du script.

© 2026 Mdm-services.fr. Tous droits réservés. Threadfin : © fyb3roptik et contributeurs, MIT.
