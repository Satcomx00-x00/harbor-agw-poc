# Ajouter une audience à un token — realm `main`

Trois méthodes pour le même résultat : la console (pour comprendre), `kcadm`
(pour reproduire), le JSON de realm (pour versionner). Puis la vérification,
qui est la seule chose qui prouve que ça a marché.

---

## 0. Ce qu'on fabrique, et pourquoi

Un *resource server* (une API, une gateway) qui valide un token vérifie la
claim `aud`. Il refuse un token qui ne le nomme pas. Keycloak ne met dans `aud`
que le client qui a demandé le token, plus les clients dont l'utilisateur porte
des rôles. Tout le reste doit être ajouté explicitement, par un **audience
mapper**.

`aud` est une **liste**. C'est ce qui permet à un seul token de satisfaire
plusieurs validateurs, au lieu d'en émettre un par destinataire.

```
avant :  "aud": "mon-client"
après :  "aud": ["mon-client", "mon-api", "ma-gateway"]
```

Avant de cliquer, fixez trois valeurs :

| | exemple | où ça sert |
|---|---|---|
| realm | `main` | fait partie de l'issuer |
| client émetteur | `mcp` | le client avec lequel on obtient le token |
| audience à ajouter | `mon-api` | ce que le resource server exige dans `aud` |

**Le mapper se pose sur le client émetteur, pas sur le destinataire.** C'est
l'erreur la plus fréquente : on veut que `mon-api` accepte le token, donc on va
configurer `mon-api`. Non. C'est `mcp` qui émet le token, donc c'est `mcp` qui
doit y écrire l'audience.

### Client audience ou custom audience

Deux champs, exclusifs l'un de l'autre.

- **Included Client Audience** — une liste déroulante des clients existants du
  realm. À utiliser quand le destinataire est déclaré comme client Keycloak.
- **Included Custom Audience** — une chaîne libre. À utiliser quand le
  destinataire n'est pas un client Keycloak : une gateway, un service qui ne
  fait que valider des tokens et n'en demande jamais. Il n'y a rien à
  sélectionner dans la liste, et c'est normal.

En cas de doute : si vous cherchez le nom dans la liste déroulante et qu'il n'y
est pas, c'est un custom audience.

---

## 1. Console d'administration

Keycloak 26. Les libellés bougent peu depuis la 21.

**1.** En haut à gauche, sélectionnez le realm **`main`**. Une modification
faite dans `master` par distraction ne produit aucune erreur et n'a aucun
effet visible.

**2.** `Clients` → cliquez sur **`mcp`** (le client émetteur).

**3.** Onglet **`Client scopes`**. Dans la liste, la première ligne s'appelle
**`mcp-dedicated`**. C'est le scope propre à ce client. Cliquez dessus.

> Un mapper posé ici ne concerne que `mcp`. Si plusieurs clients ont besoin de
> la même audience, voir la section 4.

**4.** Onglet **`Mappers`** → **`Configure a new mapper`** (ou
`Add mapper` → `By configuration` si des mappers existent déjà).

**5.** Dans la liste des types, choisissez **`Audience`**.

**6.** Remplissez :

| champ | valeur |
|---|---|
| Name | `audience-mon-api` |
| Included Client Audience | `mon-api` — *si le destinataire est un client* |
| Included Custom Audience | `mon-api` — *sinon, et laissez l'autre vide* |
| Add to ID token | **On** |
| Add to access token | **On** |
| Add to lightweight access token | On si vous utilisez les lightweight tokens |
| Add to token introspection | On |

**7.** `Save`.

### Le piège : « Add to ID token »

Le défaut ne garantit pas l'ID token. Or certains services s'authentifient avec
l'**ID token** et pas avec l'access token (Harbor, par exemple, en mode
`oidc_auth`).

Un mapper qui ne touche que l'access token produit exactement le symptôme le
plus coûteux à diagnostiquer : le token passe la gateway, puis se fait refuser
par l'API, et la gateway a l'air innocente parce qu'elle l'est. Mettez les deux
sur On, sauf raison précise de ne pas le faire.

### Répéter

Une audience = un mapper. Pour deux destinataires, deux mappers. Ils
s'additionnent dans la même liste `aud`.

---

## 2. `kcadm.sh` — la même chose, reproductible

```bash
KC=/opt/keycloak/bin/kcadm.sh   # ou `kcadm.sh` s'il est dans le PATH

# Authentification (le realm de login est master, la cible est main)
$KC config credentials \
  --server https://keycloak.example.com \
  --realm master --user admin
```

Le client se désigne par son UUID interne, pas par son `clientId` :

```bash
CID=$($KC get clients -r main -q clientId=mcp --fields id --format csv --noquotes)
echo "$CID"   # ex. 7c2f1a44-...  ; vide = le clientId est faux
```

Puis le mapper. Client audience :

```bash
$KC create clients/$CID/protocol-mappers/models -r main -f - <<'EOF'
{
  "name": "audience-mon-api",
  "protocol": "openid-connect",
  "protocolMapper": "oidc-audience-mapper",
  "config": {
    "included.client.audience": "mon-api",
    "id.token.claim": "true",
    "access.token.claim": "true",
    "introspection.token.claim": "true"
  }
}
EOF
```

Custom audience — une seule clé change :

```bash
$KC create clients/$CID/protocol-mappers/models -r main -f - <<'EOF'
{
  "name": "audience-ma-gateway",
  "protocol": "openid-connect",
  "protocolMapper": "oidc-audience-mapper",
  "config": {
    "included.custom.audience": "ma-gateway",
    "id.token.claim": "true",
    "access.token.claim": "true",
    "introspection.token.claim": "true"
  }
}
EOF
```

Relire ce qui est posé :

```bash
$KC get clients/$CID/protocol-mappers/models -r main \
  --fields name,protocolMapper,config
```

Modifier un mapper existant (`create` échouerait sur un doublon de nom) :

```bash
MID=$($KC get clients/$CID/protocol-mappers/models -r main \
      --fields id,name --format csv --noquotes | grep audience-mon-api | cut -d, -f1)
$KC update clients/$CID/protocol-mappers/models/$MID -r main \
  -s 'config."id.token.claim"=true'
```

---

## 3. Dans le JSON de realm — la version versionnée

Si le realm est importé depuis un fichier (`--import-realm`, GitOps, Terraform),
c'est là que le mapper doit vivre. Sinon la prochaine réimportation efface le
travail fait à la console.

```json
{
  "realm": "main",
  "clients": [
    {
      "clientId": "mcp",
      "publicClient": true,
      "standardFlowEnabled": true,
      "protocolMappers": [
        {
          "name": "audience-mon-api",
          "protocol": "openid-connect",
          "protocolMapper": "oidc-audience-mapper",
          "config": {
            "included.client.audience": "mon-api",
            "id.token.claim": "true",
            "access.token.claim": "true",
            "introspection.token.claim": "true"
          }
        },
        {
          "name": "audience-ma-gateway",
          "protocol": "openid-connect",
          "protocolMapper": "oidc-audience-mapper",
          "config": {
            "included.custom.audience": "ma-gateway",
            "id.token.claim": "true",
            "access.token.claim": "true",
            "introspection.token.claim": "true"
          }
        }
      ]
    }
  ]
}
```

Le realm n'est lu qu'au démarrage : après modification, il faut redémarrer le
pod ou le conteneur. Sur Kubernetes, changez une annotation du template pour
forcer le rollout, sinon rien ne redémarre.

---

## 4. Plusieurs clients ont besoin de la même audience

Ne dupliquez pas le mapper sur chaque client. Faites un client scope partagé :

```bash
# 1. le scope
$KC create client-scopes -r main -s name=aud-mon-api -s protocol=openid-connect \
  -s 'attributes."include.in.token.scope"=false'

SID=$($KC get client-scopes -r main --fields id,name --format csv --noquotes \
      | grep ',aud-mon-api' | cut -d, -f1)

# 2. le mapper dessus
$KC create client-scopes/$SID/protocol-mappers/models -r main -f - <<'EOF'
{
  "name": "audience-mon-api",
  "protocol": "openid-connect",
  "protocolMapper": "oidc-audience-mapper",
  "config": {
    "included.client.audience": "mon-api",
    "id.token.claim": "true",
    "access.token.claim": "true"
  }
}
EOF

# 3. attaché à chaque client, en default (toujours) ou optional (sur demande)
$KC update clients/$CID/default-client-scopes/$SID -r main
```

`default` : l'audience est dans tous les tokens de ce client. `optional` : il
faut la demander avec `scope=aud-mon-api` à la requête de token. Le second est
plus propre quand un client ne parle à cette API que par intermittence.

### L'alternative sans mapper

Keycloak embarque un mapper `audience resolve` dans le scope `roles`, actif par
défaut. Il ajoute automatiquement dans `aud` tout client dont l'utilisateur
porte un rôle *client* dans le token. Donc si `mon-api` déclare un rôle et que
vos utilisateurs l'ont, l'audience arrive toute seule.

Ça ne marche que pour de vrais clients Keycloak avec de vrais rôles. Pour une
gateway qui ne fait que valider, le mapper explicite reste le seul chemin.

---

## 5. Vérifier

C'est l'étape qui n'est pas optionnelle : la console ne dit jamais qu'un mapper
est inopérant.

Un token déjà émis garde son ancien `aud`. Demandez-en un nouveau.

```bash
KC_URL=https://keycloak.example.com
REALM=main

curl -s -X POST "$KC_URL/realms/$REALM/protocol/openid-connect/token" \
  -d grant_type=password \
  -d client_id=mcp \
  -d username=alice -d password='...' \
  -d 'scope=openid profile email' \
| python3 -c '
import base64, json, sys

def claims(jwt):
    p = jwt.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(p + "=" * (-len(p) % 4)))

d = json.load(sys.stdin)
for kind in ("access_token", "id_token"):
    if kind not in d:
        print(f"{kind:13}: absent"); continue
    c = claims(d[kind])
    print(f"{kind:13}: aud={c.get(\"aud\")}  iss={c[\"iss\"]}")
'
```

Attendu — `aud` est une liste, et le client émetteur y figure toujours :

```
access_token : aud=['mon-api', 'ma-gateway']  iss=https://keycloak.example.com/realms/main
id_token     : aud=['mcp', 'mon-api', 'ma-gateway']  iss=...
```

Deux remarques sur cette sortie. `mcp` peut manquer de l'access token : Keycloak
le retire quand d'autres audiences sont présentes, ce n'est pas une anomalie.
Et si `aud` est une chaîne au lieu d'une liste, c'est qu'il n'y a qu'une seule
valeur — les validateurs corrects acceptent les deux formes.

Sans password grant (client confidentiel) :

```bash
curl -s -X POST "$KC_URL/realms/$REALM/protocol/openid-connect/token" \
  -d grant_type=client_credentials \
  -d client_id=mon-service -d client_secret='...' | ...
```

Vérification côté serveur, qui a l'avantage de refléter exactement ce que
Keycloak pense du token :

```bash
curl -s -X POST "$KC_URL/realms/$REALM/protocol/openid-connect/token/introspect" \
  -u "mon-service:$SECRET" -d "token=$TOKEN" | jq '.aud, .active'
```

---

## 6. Quand ça ne marche pas

| symptôme | cause |
|---|---|
| `aud` ne contient que le client émetteur | mapper posé sur le mauvais client, ou sur un scope non attaché |
| `aud` correct sur l'access token, absent de l'ID token | `Add to ID token` est sur Off — la cause la plus fréquente |
| `aud` toujours vide après correction | vous relisez un vieux token ; redemandez-en un |
| rien ne change après édition du JSON de realm | le realm n'est lu qu'au démarrage, le pod n'a pas redémarré |
| le mapper est invisible dans la console | vous êtes dans le realm `master`, pas dans `main` |
| l'API refuse encore avec le bon `aud` | ce n'est plus l'audience : vérifiez `iss` au caractère près, et que l'API valide bien le type de token que vous lui envoyez (ID vs access) |
| `unknown_error` à la création du mapper | `included.client.audience` **et** `included.custom.audience` renseignés tous les deux |

Où regarder :

```bash
kubectl -n keycloak logs deploy/keycloak | grep -i -E 'mapper|audience|realm'
```

Et la source de vérité sur ce que Keycloak émet réellement, sans passer par
l'application : `Clients` → `mcp` → onglet **`Client scopes`** → sous-onglet
**`Evaluate`**. Choisissez un utilisateur, puis `Generated access token` /
`Generated ID token`. Le token affiché est celui que Keycloak produirait, avec
la configuration actuelle. Si `aud` est bon ici et faux dans votre application,
le problème n'est pas dans Keycloak.
