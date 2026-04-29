# AirOps blue-team scenarios

AirOps est un lab Kubernetes volontairement vulnerable pour entrainer une blue-team a enqueter dans les logs applicatifs, les events Kubernetes et l'etat des workloads.

Les vulnerabilites sont intentionnelles et visibles dans les annotations Kubernetes `lab.vulnkube.io/*`.

## Flux applicatif

- `caddy` expose le lab en NodePort et reverse-proxy `/graphql` vers l'API.
- `/api/*` expose aussi des endpoints agent, par exemple la telemetrie avion.
- `frontend` sert l'interface web statique.
- `api` expose GraphQL, initialise les donnees PostgreSQL et journalise en JSON.
- `postgresql` stocke les vols, positions, previsions meteo, operateurs et clearances.
- `redis` stocke les sessions faibles.
- `minio` simule un bucket S3 `flight-data`.

## Sources de logs utiles

```bash
kubectl -n airops logs deploy/airops-airops-api -f
kubectl -n airops logs deploy/airops-airops-caddy -f
kubectl -n airops get events --sort-by=.lastTimestamp
kubectl -n airops describe pod -l lab.vulnkube.io/vulnerable=true
```

Les logs API contiennent `event`, `requestId`, `actor`, `ip`, `path`, `method` et des champs propres au scenario.

## Scenario 1: Injection SQL GraphQL

Objectif blue-team: detecter une recherche anormale sur les vols.

Declencheur:

```graphql
query {
  flights(search: "%' OR '1'='1") {
    id
    flightNo
    notes
  }
}
```

Traces attendues:

- Log API `event=flight.search`.
- Champ `sql` contenant une clause inattendue.
- Volume de resultats plus large qu'une recherche normale.

Hypotheses d'enquete:

- Quel acteur a lance la requete ?
- Depuis quelle IP ?
- La requete est-elle passee par Caddy ?
- Des consultations S3 ou clearances suivent-elles immediatement ?

## Scenario 2: IDOR sur les clearances

Objectif blue-team: detecter une consultation de clearance non autorisee.

Declencheur:

```graphql
query {
  clearance(id: 3) {
    id
    flightId
    route
    sharedWith
  }
}
```

Traces attendues:

- Log API `event=clearance.read`.
- Champ `warning=idor_lab_endpoint`.
- `actor` different de `sharedWith` dans la reponse.

## Scenario 3: Authentification faible et changement d'etat vol

Objectif blue-team: identifier une modification operationnelle suspecte.

Declencheur:

```graphql
mutation {
  updateFlightStatus(id: 1, status: "DIVERTED") {
    flightNo
    status
  }
}
```

Traces attendues:

- Log API `event=flight.status.update`.
- Champ `token` absent ou incoherent.
- Changement d'etat visible dans les recherches suivantes.

## Scenario 4: SSRF via recuperation METAR

Objectif blue-team: trouver une tentative de fetch interne depuis l'API.

Le champ `fetchMetar(url: String!)` est presente comme un recuperateur de donnees meteo, mais l'API execute le `fetch` cote serveur sans liste blanche de domaines. Un attaquant peut donc utiliser l'API comme proxy HTTP depuis le pod `api`, avec la visibilite reseau interne du cluster.

Declencheur:

```graphql
query {
  fetchMetar(url: "http://airops-airops-minio:9000/minio/health/live")
}
```

Abus possibles:

- Decouverte de services internes Kubernetes via DNS de service, par exemple `http://airops-airops-keycloak:8080/auth/realms/airops` ou `http://airops-airops-api:4000/readyz`.
- Validation de ports HTTP internes par differences de reponse, de timeout ou d'erreur.
- Lecture de endpoints de sante qui revelent qu'un service existe, qu'il est pret, ou qu'il expose une version.
- Acces indirect a des consoles ou APIs internes non prevues pour etre appelees par le navigateur.
- En environnement cloud, tentative classique vers un endpoint metadata comme `http://169.254.169.254/`, si le reseau du cluster l'autorise.

Exemples d'URLs de test dans ce lab:

```graphql
query {
  fetchMetar(url: "http://airops-airops-api:4000/healthz")
}
```

```graphql
query {
  fetchMetar(url: "http://airops-airops-api:4000/readyz")
}
```

```graphql
query {
  fetchMetar(url: "http://airops-airops-keycloak:8080/auth/realms/airops")
}
```

```graphql
query {
  fetchMetar(url: "http://airops-airops-minio:9000/minio/health/ready")
}
```

Traces attendues:

- Log API `event=weather.fetch`.
- Champ `warning=ssrf_lab_endpoint`.
- URL interne Kubernetes ou service DNS interne.
- User-agent normal du navigateur cote Caddy, puis requete sortante initiee par le pod API.
- Timeouts courts ou erreurs reseau repetes si l'attaquant scanne des ports.

Limites utiles a connaitre:

- Le code utilise `fetch`, donc le cas nominal est HTTP/HTTPS. Ce n'est pas un client TCP brut vers Redis, PostgreSQL ou LDAP.
- Le resolver fait une requete `GET`, pas un `POST`; il peut lire des endpoints HTTP simples, mais ne poste pas directement un body GraphQL via ce chemin.
- L'impact reste fort pour la reconnaissance interne, la fuite de banners, la consultation de health checks et les metadata services mal proteges.

Detection et chasse:

- Chercher `event=weather.fetch` avec `url` commencant par `http://airops-`, `http://10.`, `http://127.`, `http://localhost`, `http://169.254.`, ou contenant `.svc`.
- Alerter si plusieurs `weather.fetch` visent des hôtes differents dans une fenetre courte.
- Comparer avec l'usage attendu: un vrai METAR devrait viser une source meteo externe connue, pas des services Kubernetes internes.
- Correler les SSRF avec une reconnaissance GraphQL precedente ou des actions sensibles qui suivent.

Contremesures attendues dans une vraie application:

- Liste blanche stricte de domaines meteo autorises.
- Blocage des IP privees, loopback, link-local et domaines internes.
- Resolution DNS controlee cote serveur et validation apres resolution.
- Timeouts, quotas par utilisateur et journalisation de la destination resolue.

## Scenario 5: Upload S3 non valide

Objectif blue-team: detecter un objet suspect pousse dans le bucket de rapports.

Declencheur:

```graphql
mutation {
  uploadReport(filename: "handover.html", content: "<script>alert('lab')</script>") 
}
```

Traces attendues:

- Log API `event=s3.upload`.
- `key=reports/handover.html`.
- Taille et nom d'objet anormaux.

## Scenario 6: Chaine d'investigation

Objectif blue-team: relier plusieurs signaux faibles.

Sequence:

1. Recherche SQLi sur `flights`.
2. Lecture IDOR de `clearance(id: 3)`.
3. Fetch SSRF vers un service interne.
4. Upload d'un rapport S3.
5. Changement de statut d'un vol.

Artefacts a correler:

- Meme `ip` ou `actor`.
- Fenetre temporelle courte.
- Logs Caddy puis API.
- Events Kubernetes si pods redemarrent ou si probes echouent.
- Objets crees dans MinIO.

## Scenario 7: Injection de telemetrie avion

Objectif blue-team: detecter un agent qui modifie les positions avion sans authentification forte.

Declencheur REST:

```bash
curl -X POST http://127.0.0.1:30080/api/flights/AFR431/position \
  -H 'content-type: application/json' \
  -H 'x-operator: maintenance-bot' \
  -d '{"latitude": 43.2, "longitude": -12.8, "altitude": 12000, "heading": 90, "status": "DIVERTED"}'
```

Declencheur GraphQL:

```graphql
mutation {
  updateFlightPosition(
    flightNo: "AFR431",
    latitude: 43.2,
    longitude: -12.8,
    altitude: 12000,
    heading: 90,
    status: "DIVERTED"
  ) {
    flightNo
    latitude
    longitude
    altitude
    heading
    status
  }
}
```

Traces attendues:

- Log API `event=flight.position.update`.
- Champ `warning=weak-telemetry-auth`.
- `source=rest` ou `source=graphql`.
- `actor` provenant du bearer faible ou du header spoofable `x-operator`.
- Changement visible dans la carte des vols.

Points d'enquete:

- L'agent est-il attendu sur ce reseau ?
- Le cap, l'altitude ou le statut sont-ils incoherents avec le plan de vol ?
- Y a-t-il plusieurs updates rapides depuis la meme IP ?

## Scenario 8: Simulation d'un agent compromis

Objectif blue-team: observer une sequence realiste de positions poussees par un agent automatisé.

Declencheur:

```bash
./scripts/simulate-flight-positions.py --base-url http://127.0.0.1:30080 --interval 1
```

Variante plus discrete:

```bash
./scripts/simulate-flight-positions.py --callsign goose --interval 8
```

Traces attendues:

- Rafale de logs `flight.position.update`.
- User-agent `airops-position-agent/0.1`.
- Cles Redis `telemetry:<FLIGHT_NO>:last` mises a jour pendant 10 minutes.
- La carte bouge au fil des rafraichissements frontend.

Vulnerabilite documentee:

- L'API accepte des positions via un token faible et un header `x-operator` spoofable.
- Il n'y a pas de validation geographique, de signature de message, ni de controle de vitesse impossible.

## Scenario 9: Consultation meteo et reconnaissance operationnelle

Objectif blue-team: detecter la collecte de previsions sur plusieurs aeroports disponibles.

Declencheur GraphQL:

```graphql
query {
  weatherForecast(airport: "LFPG", hours: 12) {
    airport
    validFrom
    validTo
    summary
    wind
    ceiling
    risk
  }
}
```

Recherche large:

```graphql
query {
  weatherForecast(hours: 24) {
    airport
    risk
    wind
  }
}
```

Traces attendues:

- Log API `event=weather.forecast`.
- `airport=*` lors d'une collecte large.
- Suite possible avec `flight.search`, `clearance.read` ou `flight.position.update`.

Vulnerabilite documentee:

- Les previsions operationnelles sont consultables par tout utilisateur ayant acces a la GUI operationnelle.
- Le endpoint accepte une recherche globale sans limitation fine par zone d'affectation.

## Scenario 10: Reconnaissance GraphQL par introspection

Objectif blue-team: detecter un attaquant qui cartographie ce que l'API GraphQL expose avant de choisir une vulnerabilite.

GraphQL peut exposer son schema via introspection quand cette fonction est active. Dans ce lab, l'API Apollo est lancee avec `introspection: true`. Un attaquant n'a donc pas besoin de lire le code source ni le frontend: il peut demander au serveur la liste des queries, mutations, types et champs disponibles.

Declencheur minimal:

```graphql
query {
  __schema {
    queryType {
      fields {
        name
      }
    }
    mutationType {
      fields {
        name
      }
    }
  }
}
```

Declencheur detaille pour les mutations:

```graphql
query {
  __type(name: "Mutation") {
    fields {
      name
      args {
        name
        type {
          kind
          name
          ofType {
            kind
            name
          }
        }
      }
    }
  }
}
```

Declencheur detaille pour les objets metier:

```graphql
query {
  __type(name: "Flight") {
    fields {
      name
      type {
        kind
        name
        ofType {
          kind
          name
        }
      }
    }
  }
}
```

Exemple avec `curl`:

```bash
curl -s http://127.0.0.1:30080/graphql \
  -H 'content-type: application/json' \
  -d '{"query":"query { __schema { queryType { fields { name } } mutationType { fields { name } } } }"}'
```

Ce que l'attaquant apprend:

- Les queries disponibles: `flights`, `flight`, `currentOperator`, `clearance`, `s3Objects`, `weatherForecast`, `fetchMetar`.
- Les mutations disponibles: `login`, `loginSession`, `register`, `updateFlightStatus`, `updateFlightPosition`, `uploadReport`.
- Les champs sensibles des objets, par exemple `Flight.notes`, `Flight.latitude`, `Flight.longitude`, `Clearance.sharedWith`, `WeatherForecast.risk`.
- Les arguments necessaires pour construire des appels valides, par exemple `fetchMetar(url)`, `weatherForecast(airport, hours)`, `updateFlightPosition(flightNo, latitude, longitude, altitude, heading, status)`.

Chemin d'attaque typique:

1. Introspection pour lister queries et mutations.
2. Lecture de `Flight` pour identifier les champs disponibles.
3. Recherche large `flights(search: "%")` ou injection SQL sur `search`.
4. Lecture IDOR de `clearance(id)`.
5. Reconnaissance interne via `fetchMetar(url)`.
6. Modification d'etat ou de position via `updateFlightStatus` ou `updateFlightPosition`.

Traces attendues:

- Requetes `/graphql` avec `__schema` ou `__type` dans le body.
- Souvent peu ou pas de logs metier applicatifs, car l'introspection est traitee par Apollo avant les resolvers metier.
- Dans les logs Caddy, une serie de POST `/graphql` avant les appels `flight.search`, `weather.fetch`, `clearance.read` ou `flight.position.update`.

Detection et chasse:

- Inspecter les logs de reverse proxy ou d'API pour les chaines `__schema`, `__type`, `IntrospectionQuery`.
- Alerter si l'introspection vient d'un navigateur utilisateur normal ou d'une IP qui n'est pas un outil d'administration.
- Correler une introspection avec une augmentation des erreurs GraphQL: les attaquants testent souvent plusieurs noms de champs.
- Surveiller les clients qui demandent ensuite `fetchMetar`, `s3Objects` ou des mutations operationnelles.

Contremesures attendues dans une vraie application:

- Desactiver l'introspection en production ou la limiter aux roles d'administration.
- Exiger une authentification forte avant toute requete GraphQL.
- Journaliser le body GraphQL de facon controlee, ou au minimum le nom d'operation.
- Mettre en place une allowlist d'operations pour le frontend.
- Appliquer des controles d'autorisation par resolver, pas seulement dans la GUI.
