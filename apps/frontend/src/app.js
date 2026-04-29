const api = "/graphql";
const protectedRoles = new Set(["admin", "controller", "analyst"]);
const viewTitles = {
  dashboard: "Tableau de bord",
  flights: "Vols & carte",
  clearances: "Clearances",
  weather: "Meteo",
  reports: "Rapports",
  identity: "Identite"
};
const mapBounds = {
  minLat: 41,
  maxLat: 52,
  minLon: -6,
  maxLon: 10
};

let session = readSession();
let currentView = "dashboard";
let latestFlights = [];
let mapView = { x: 0, y: 0, zoom: 1 };
let mapDrag = null;

async function loadApiFooter() {
  try {
    const response = await fetch("/api/footer");
    const footer = await response.json();
    document.querySelector("#api-footer").textContent = `${footer.service} ${footer.version} / ${footer.stack}`;
  } catch {
    document.querySelector("#api-footer").textContent = "AirOps API / GraphQL / Telemetry";
  }
}

async function gql(query, variables = {}) {
  const headers = {
    "content-type": "application/json"
  };
  if (session?.token) {
    headers.authorization = `Bearer ${session.token}`;
    headers["x-operator"] = session.operator.callsign;
  }

  const response = await fetch(api, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables })
  });
  const payload = await response.json();
  if (payload.errors) throw new Error(payload.errors.map((e) => e.message).join(", "));
  return payload.data;
}

function readSession() {
  try {
    return JSON.parse(localStorage.getItem("session") || "null");
  } catch {
    return null;
  }
}

function hasAccess() {
  return protectedRoles.has(session?.operator?.role);
}

function saveSession(nextSession) {
  session = nextSession;
  localStorage.setItem("session", JSON.stringify(nextSession));
  localStorage.setItem("operator", nextSession.operator.callsign);
  renderAppState();
}

function clearSession() {
  localStorage.removeItem("session");
  localStorage.removeItem("operator");
  session = null;
  renderAppState();
}

function renderAppState() {
  const loginScreen = document.querySelector("#login-screen");
  const appScreen = document.querySelector("#app-screen");
  const denied = document.querySelector("#access-denied");
  const authorized = document.querySelector("#authorized-content");
  const sessionTarget = document.querySelector("#session");
  const operatorCard = document.querySelector("#operator-card");
  const mainNav = document.querySelector("#main-nav");
  const mobileNav = document.querySelector("#mobile-nav");

  if (!session) {
    loginScreen.classList.remove("hidden");
    appScreen.classList.add("hidden");
    return;
  }

  loginScreen.classList.add("hidden");
  appScreen.classList.remove("hidden");
  sessionTarget.textContent = `${session.operator.callsign} / ${session.operator.role}`;

  if (!hasAccess()) {
    denied.classList.remove("hidden");
    authorized.classList.add("hidden");
    mainNav.classList.add("hidden");
    mobileNav.classList.add("hidden");
    document.querySelector("#view-title").textContent = "Acces refuse";
    return;
  }

  denied.classList.add("hidden");
  authorized.classList.remove("hidden");
  mainNav.classList.remove("hidden");
  mobileNav.classList.remove("hidden");
  operatorCard.innerHTML = `
    <strong class="block text-white">${session.operator.displayName}</strong>
    <span class="block">${session.operator.callsign}</span>
    <span class="block">${session.operator.email || "email absent"}</span>
    <span class="mt-2 inline-flex rounded-full bg-radar/10 px-3 py-1 text-xs font-bold text-radar">${session.operator.role}</span>
  `;
  switchView(currentView);
  loadFlights();
  loadForecast();
  loadClearances();
}

function showError(target, error) {
  target.textContent = `Erreur: ${error.message}`;
}

function switchView(view) {
  currentView = view;
  document.querySelector("#view-title").textContent = viewTitles[view] || viewTitles.dashboard;
  document.querySelectorAll(".view-section").forEach((section) => {
    section.classList.toggle("hidden", section.dataset.view !== view);
  });
  document.querySelectorAll("[data-view-target]").forEach((button) => {
    button.classList.toggle("active", button.dataset.viewTarget === view);
  });
}

function project(flight) {
  const x = ((flight.longitude - mapBounds.minLon) / (mapBounds.maxLon - mapBounds.minLon)) * 100;
  const y = (1 - ((flight.latitude - mapBounds.minLat) / (mapBounds.maxLat - mapBounds.minLat))) * 100;
  return {
    x: Math.max(4, Math.min(96, x)),
    y: Math.max(8, Math.min(92, y))
  };
}

function setMapView(nextView) {
  mapView = {
    x: Math.max(-38, Math.min(38, nextView.x)),
    y: Math.max(-32, Math.min(32, nextView.y)),
    zoom: Math.max(0.8, Math.min(2.8, nextView.zoom))
  };
  renderMap(latestFlights);
}

function renderMap(flights) {
  const map = document.querySelector("#flight-map");
  if (!flights.length) {
    map.innerHTML = `<div class="map-empty">Aucun vol disponible.</div>`;
    return;
  }

  map.innerHTML = `
    <div class="france-shape"></div>
    <div class="map-label label-paris">Paris FIR</div>
    <div class="map-label label-brest">Brest</div>
    <div class="map-label label-bordeaux">Bordeaux</div>
    <div class="map-label label-marseille">Marseille</div>
    <div class="map-label label-reims">Reims</div>
    <div class="map-viewport" style="transform: translate(${mapView.x}%, ${mapView.y}%) scale(${mapView.zoom})">
      ${flights.map((flight) => {
    const point = project(flight);
    return `
      <button class="map-flight" style="left:${point.x}%;top:${point.y}%;--heading:${flight.heading}deg" data-flight-id="${flight.id}">
        <span class="plane"></span>
        <strong>${flight.flightNo}</strong>
        <small>${flight.altitude} ft / ${flight.speed} kt</small>
      </button>
    `;
  }).join("")}
    </div>
  `;

  map.querySelectorAll(".map-flight").forEach((button) => {
    button.addEventListener("click", () => {
      const flight = flights.find((item) => String(item.id) === button.dataset.flightId);
      document.querySelector("#map-detail").textContent =
        `${flight.flightNo} ${flight.origin}->${flight.destination}
${flight.aircraftType} / ${flight.registration} / squawk ${flight.squawk}
${flight.status} / secteur ${flight.sector} / ${flight.ownerCallsign}
${flight.altitude} ft / ${flight.speed} kt / cap ${flight.heading} / vario ${flight.verticalRate} ft.min
Maj ${new Date(flight.updatedAt).toLocaleTimeString()}
${flight.notes}`;
    });
  });
}

async function loadFlights(event) {
  event?.preventDefault();
  if (!hasAccess()) return;

  const target = document.querySelector("#flights");
  target.textContent = "Chargement...";
  try {
    const data = await gql(
      `query Flights($search: String) {
        flights(search: $search) {
          id flightNo origin destination status altitude ownerCallsign notes latitude longitude heading speed verticalRate aircraftType registration squawk sector updatedAt
        }
      }`,
      { search: document.querySelector("#search").value }
    );
    latestFlights = data.flights;
    target.innerHTML = data.flights.map((flight) => `
      <article class="flight">
        <div class="flex items-start justify-between gap-3">
          <div>
            <strong>${flight.flightNo} - ${flight.status}</strong>
            <span>${flight.origin} -> ${flight.destination} / ${flight.aircraftType} ${flight.registration}</span>
            <small>${flight.altitude} ft / ${flight.speed} kt / HDG ${flight.heading} / SQK ${flight.squawk} / ${flight.sector}</small>
            <small>${flight.ownerCallsign} - ${flight.notes}</small>
          </div>
          <span class="rounded-full bg-radar/10 px-3 py-1 text-xs font-bold text-radar">${flight.speed} kt</span>
        </div>
      </article>
    `).join("");
    renderMap(data.flights);
  } catch (error) {
    target.textContent = error.message;
    document.querySelector("#flight-map").innerHTML = `<div class="map-empty">${error.message}</div>`;
  }
}

async function loadForecast(event) {
  event?.preventDefault();
  if (!hasAccess()) return;

  const target = document.querySelector("#forecast");
  target.textContent = "Chargement...";
  try {
    const data = await gql(
      `query WeatherForecast($airport: String, $hours: Int) {
        weatherForecast(airport: $airport, hours: $hours) {
          airport validFrom validTo summary wind visibility ceiling risk
        }
      }`,
      {
        airport: document.querySelector("#forecast-airport").value,
        hours: Number(document.querySelector("#forecast-hours").value || 12)
      }
    );
    if (!data.weatherForecast.length) {
      target.innerHTML = `<div class="forecast-card">Aucune prévision disponible pour cet endroit.</div>`;
      return;
    }
    target.innerHTML = data.weatherForecast.map((item) => `
      <article class="forecast-card">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <strong>${item.airport} - ${item.risk}</strong>
            <span>${new Date(item.validFrom).toLocaleString()} -> ${new Date(item.validTo).toLocaleString()}</span>
          </div>
          <span class="rounded-full bg-signal/10 px-3 py-1 text-xs font-bold text-signal">${item.wind}</span>
        </div>
        <p>${item.summary}</p>
        <small>Visibilite ${item.visibility} / plafond ${item.ceiling}</small>
      </article>
    `).join("");
  } catch (error) {
    showError(target, error);
  }
}

function renderClearanceDetail(clearance) {
  document.querySelector("#clearance-title").textContent = `${clearance.flightNo} / CLR-${clearance.id}`;
  document.querySelector("#clearance-detail").innerHTML = `
    <div class="grid gap-3">
      <div class="clearance-strip">
        <span>Route</span>
        <strong>${clearance.route}</strong>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div class="clearance-metric">
          <span>Origine</span>
          <strong>${clearance.origin}</strong>
        </div>
        <div class="clearance-metric">
          <span>Destination</span>
          <strong>${clearance.destination}</strong>
        </div>
        <div class="clearance-metric">
          <span>Statut vol</span>
          <strong>${clearance.status}</strong>
        </div>
        <div class="clearance-metric">
          <span>Partage</span>
          <strong>${clearance.sharedWith}</strong>
        </div>
      </div>
      <div class="rounded-md border border-signal/30 bg-signal/10 p-3 text-sm leading-6 text-slate-200">
        Cette fiche est chargee par ID sans controle d'appartenance strict, afin de rendre le scenario IDOR observable.
      </div>
    </div>
  `;
}

async function readClearance(id) {
  const data = await gql(
    `query Clearance($id: ID!) {
      clearance(id: $id) {
        id flightId flightNo origin destination status route sharedWith
      }
    }`,
    { id }
  );
  return data.clearance;
}

async function loadClearances(event) {
  event?.preventDefault();
  if (!hasAccess()) return;

  const target = document.querySelector("#clearances-list");
  target.textContent = "Chargement...";
  try {
    const data = await gql(
      `query Clearances($search: String) {
        clearances(search: $search) {
          id flightId flightNo origin destination status route sharedWith
        }
      }`,
      { search: document.querySelector("#clearances-search").value }
    );
    if (!data.clearances.length) {
      target.innerHTML = `<div class="p-4 text-sm text-slate-400">Aucune clearance active.</div>`;
      return;
    }
    target.innerHTML = data.clearances.map((clearance) => `
      <button class="clearance-row" data-clearance-id="${clearance.id}">
        <span class="font-bold text-radar">CLR-${clearance.id}</span>
        <span>
          <strong>${clearance.flightNo}</strong>
          <small>${clearance.origin} -> ${clearance.destination} / ${clearance.route}</small>
        </span>
        <span>${clearance.status}</span>
        <span>${clearance.sharedWith}</span>
      </button>
    `).join("");
    target.querySelectorAll("[data-clearance-id]").forEach((button) => {
      button.addEventListener("click", async () => {
        const clearance = await readClearance(button.dataset.clearanceId);
        renderClearanceDetail(clearance);
        document.querySelector("#clearance").textContent = JSON.stringify(clearance, null, 2);
        document.querySelector("#clearance-id").value = clearance.id;
      });
    });
    renderClearanceDetail(data.clearances[0]);
  } catch (error) {
    showError(target, error);
  }
}

document.querySelector("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const target = document.querySelector("#auth-result");
  try {
    const data = await gql(
      `mutation Login($callsign: String!, $password: String!) {
        loginSession(callsign: $callsign, password: $password) {
          token
          operator { callsign displayName email role }
        }
      }`,
      {
        callsign: document.querySelector("#login-callsign").value,
        password: document.querySelector("#login-password").value
      }
    );
    saveSession(data.loginSession);
    target.textContent = `Connecte: ${data.loginSession.operator.displayName}`;
  } catch (error) {
    showError(target, error);
  }
});

document.querySelector("#signup-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const target = document.querySelector("#auth-result");
  try {
    const data = await gql(
      `mutation Register($callsign: String!, $password: String!, $displayName: String, $email: String) {
        register(callsign: $callsign, password: $password, displayName: $displayName, email: $email) {
          token
          operator { callsign displayName email role }
        }
      }`,
      {
        callsign: document.querySelector("#signup-callsign").value,
        password: document.querySelector("#signup-password").value,
        displayName: document.querySelector("#signup-name").value,
        email: document.querySelector("#signup-email").value
      }
    );
    saveSession(data.register);
    target.textContent = `Compte viewer cree: ${data.register.operator.callsign}. Aucun droit operationnel.`;
  } catch (error) {
    showError(target, error);
  }
});

document.querySelector("#logout").addEventListener("click", clearSession);
document.querySelector("#search-form").addEventListener("submit", loadFlights);
document.querySelector("#clearances-form").addEventListener("submit", loadClearances);
document.querySelector("#forecast-form").addEventListener("submit", loadForecast);
document.querySelector("#map-zoom-in").addEventListener("click", () => setMapView({ ...mapView, zoom: mapView.zoom + 0.2 }));
document.querySelector("#map-zoom-out").addEventListener("click", () => setMapView({ ...mapView, zoom: mapView.zoom - 0.2 }));
document.querySelector("#map-reset").addEventListener("click", () => setMapView({ x: 0, y: 0, zoom: 1 }));
document.querySelectorAll("[data-view-target]").forEach((button) => {
  button.addEventListener("click", () => switchView(button.dataset.viewTarget));
});

document.querySelector("#flight-map").addEventListener("pointerdown", (event) => {
  if (event.target.closest(".map-flight")) return;
  mapDrag = { clientX: event.clientX, clientY: event.clientY, x: mapView.x, y: mapView.y };
  event.currentTarget.setPointerCapture(event.pointerId);
});

document.querySelector("#flight-map").addEventListener("pointermove", (event) => {
  if (!mapDrag) return;
  const rect = event.currentTarget.getBoundingClientRect();
  setMapView({
    ...mapView,
    x: mapDrag.x + ((event.clientX - mapDrag.clientX) / rect.width) * 100,
    y: mapDrag.y + ((event.clientY - mapDrag.clientY) / rect.height) * 100
  });
});

document.querySelector("#flight-map").addEventListener("pointerup", () => {
  mapDrag = null;
});

document.querySelector("#clearance-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const target = document.querySelector("#clearance");
  if (!hasAccess()) return;
  try {
    const clearance = await readClearance(document.querySelector("#clearance-id").value);
    renderClearanceDetail(clearance);
    target.textContent = JSON.stringify(clearance, null, 2);
  } catch (error) {
    showError(target, error);
  }
});

document.querySelector("#metar-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const target = document.querySelector("#metar");
  if (!hasAccess()) return;
  try {
    const data = await gql(
      `query FetchMetar($url: String!) { fetchMetar(url: $url) }`,
      { url: document.querySelector("#metar-url").value }
    );
    target.textContent = data.fetchMetar.slice(0, 2000);
  } catch (error) {
    showError(target, error);
  }
});

document.querySelector("#upload-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const target = document.querySelector("#upload");
  if (!hasAccess()) return;
  try {
    const data = await gql(
      `mutation Upload($filename: String!, $content: String!) { uploadReport(filename: $filename, content: $content) }`,
      {
        filename: document.querySelector("#filename").value,
        content: document.querySelector("#content").value
      }
    );
    target.textContent = `Objet cree: ${data.uploadReport}`;
  } catch (error) {
    showError(target, error);
  }
});

renderAppState();
loadApiFooter();
