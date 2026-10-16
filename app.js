"use strict";

const STORAGE_KEY = "shinyquest-za";
const SETTINGS_KEY = "shinyquest-za-settings";
const SPECIES_API = "https://pokeapi.co/api/pokemon-species/";
const POKEMON_API = "https://pokeapi.co/api/pokemon/";
const BASE_SHINY_ROLL = 1 / 4096;
const $ = (selector) => document.querySelector(selector);
const safe = (input) => String(input ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[char]);
const titleCase = (name) => String(name).replace(/\b[a-z]/g, (letter) => letter.toUpperCase()).replace(/-/g, " ");
const number = (value) => new Intl.NumberFormat("en-GB").format(value);
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const uid = () => (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;

let hunts = readSavedHunts();
let selectedPokemon = null;
let completingHuntId = null;
let settings = readSettings();
let recordPokemon = null;
let editingRecordId = null;
let lookupSequence = 0;
let activeView = "dashboard";
const viewPositions = {dashboard:0, hunts:0, collection:0, pokedex:0};
function readSettings() {
  try {const data = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"); return {shinyCharm: data.shinyCharm === true};}
  catch {return {shinyCharm:false};}
}
function saveSettings() {
  try {localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));}
  catch {showStatus("Unable to save preferences in this browser.", true);}
}
function updateCharmDisplay() {
  $("#global-charm").checked = settings.shinyCharm;
  $("#charm-state").textContent = settings.shinyCharm ? "Unlocked · New wild hunts boosted" : "Not unlocked · Standard wild odds";
}


function expectedChecks(hunt) {
  return 1 / getProbabilityPerCheck(hunt);
}

function oddsDifference(hunt) {
  if (!hunt.checks || hunt.unknownChecks) return null;
  return 100 * (hunt.checks / expectedChecks(hunt) - 1);
}

function oddsComparisonMarkup(hunt, withExpected = false) {
  const difference = oddsDifference(hunt);
  const expected = expectedChecks(hunt);
  if (difference === null) return `<span class="muted">Unknown – 0 checks recorded</span>`;
  const abs = Math.abs(difference);
  const description = abs < 0.05 ? "at expected odds" : difference < 0 ? "below expected" : "above expected";
  const cls = abs < 0.05 ? "neutral" : difference < 0 ? "lucky" : "unlucky";
  return `<span class="odds-comparison ${cls}">${abs.toFixed(1)}% ${description}</span>${withExpected ? `<span class="muted-label"> · Expected average: ${number(Math.round(expected))} checks</span>` : ""}`;
}

function completedInDateOrder() {
  return hunts.map((hunt, order) => ({hunt, order}))
    .filter(({hunt}) => hunt.status === "found")
    .sort((a, b) => {
      const d1 = Date.parse(a.hunt.caughtAt || a.hunt.foundDate || a.hunt.started || "1970-01-01") || 0;
      const d2 = Date.parse(b.hunt.caughtAt || b.hunt.foundDate || b.hunt.started || "1970-01-01") || 0;
      return d2 - d1 || b.order - a.order;
    }).map(({hunt}) => hunt);
}

function shinyIconUrl(id) {
  return `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/shiny/${Number(id)}.png`;
}


function readSavedHunts() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter(isValidHunt) : [];
  } catch (error) {
    console.warn("Could not read saved hunts:", error);
    return [];
  }
}

function isValidHunt(hunt) {
  return !!hunt && typeof hunt === "object" && typeof hunt.id === "string" &&
    typeof hunt.name === "string" && typeof hunt.pokemonId === "number" &&
    Number.isSafeInteger(hunt.checks) && hunt.checks >= 0 && hunt.checks <= 1e9 &&
    typeof hunt.charm === "boolean" && ["active", "found"].includes(hunt.status);
}

function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(hunts)); }
  catch { showStatus("Could not save changes. Your browser storage may be full.", true); }
}

function showStatus(message, error = false) {
  const el = $("#status");
  el.textContent = message;
  el.style.color = error ? "var(--danger)" : "var(--teal)";
}

function getProbabilityPerCheck(hunt) {
  const rolls = hunt.method === "fossil" ? 1 : hunt.charm ? 4 : 1;
  return 1 - Math.pow(1 - BASE_SHINY_ROLL, rolls);
}

function cumulativeChance(checks, p) {
  return 100 * (-Math.expm1(checks * Math.log1p(-p)));
}

function spriteFromPokemon(pokemon) {
  return pokemon.sprites?.other?.home?.front_shiny ||
    pokemon.sprites?.other?.["official-artwork"]?.front_shiny ||
    pokemon.sprites?.front_shiny || pokemon.sprites?.front_default || "";
}

function normalSpriteFromPokemon(pokemon) {
  return pokemon.sprites?.other?.home?.front_default ||
    pokemon.sprites?.other?.["official-artwork"]?.front_default ||
    pokemon.sprites?.front_default || "";
}

function imageTag(src, alt) {
  if (!src || !/^https:\/\//.test(src)) return `<span class="muted">No sprite available</span>`;
  return `<img src="${safe(src)}" alt="${safe(alt)}" loading="lazy">`;
}

function setView(view) {
  if (!(["dashboard", "hunts", "collection", "pokedex"].includes(view))) return;
  viewPositions[activeView] = window.scrollY;
  activeView = view;
  for (const name of ["dashboard", "hunts", "collection", "pokedex"]) {
    $(`#view-${name}`).hidden = view !== name;
  }
  document.querySelectorAll(".tab").forEach((tab) => {
    const active = tab.dataset.view === view;
    tab.classList.toggle("active", active);
    if (active) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  });
  render();
  requestAnimationFrame(() => window.scrollTo({left:0, top:viewPositions[view] ?? 0, behavior:"instant"}));
}

function render({updateDex=true} = {}) {
  const found = hunts.filter((hunt) => hunt.status === "found");
  const active = hunts.filter((hunt) => hunt.status === "active");
  const checks = hunts.reduce((sum, hunt) => sum + hunt.checks, 0);
  const unique = new Set(found.map((hunt) => hunt.pokemonId)).size;
  $("#overview-stats").innerHTML = [
    ["Shinies found", found.length], ["Active hunts", active.length],
    ["Checks recorded", number(checks)], ["Unique species", unique]
  ].map(([label, value]) => `<article class="stat-card"><span>${label}</span><strong>${value}</strong></article>`).join("");

  renderShinyLeaderboard(found);
  if (updateDex) renderDex();

  const recent = [...hunts].reverse().slice(0, 3);
  $("#recent-hunts").innerHTML = recent.length
    ? recent.map(huntSummary).join("") : `<div class="empty">No hunts yet. Search for a Pokemon to start one.</div>`;
  $("#hunts-list").innerHTML = active.length
    ? [...active].reverse().map(renderHunt).join("") : `<div class="empty">No active hunts. Start one from the Overview tab.</div>`;
  renderCollectionList();
  $("#collection-total").textContent = `${found.length} collected`;
}


function renderShinyLeaderboard() {
  const completed = completedInDateOrder();
  const latest = completed[0];
  const latestElement = $("#latest-shiny");
  if (!latest) {
    latestElement.innerHTML = `<div class="empty">No shiny Pokémon caught yet. Complete your first hunt and it will appear here, along with your top-five rankings.</div>`;
  } else {
    const odds = number(Math.round(expectedChecks(latest)));
    latestElement.innerHTML = `<div class="latest-shiny-content">
      <div class="latest-art">${imageTag(latest.shinySprite || shinyIconUrl(latest.pokemonId), `Shiny ${titleCase(latest.name)}`)}</div>
      <div class="latest-info"><p class="eyebrow">${safe(latest.foundDate || "Date not recorded")}</p>
        <h3>${safe(titleCase(latest.nickname || latest.name))}</h3>
        ${latest.nickname ? `<p class="muted">${safe(titleCase(latest.name))}</p>` : ""}
        <div class="latest-count">${number(latest.checks)} <span>checks to catch</span></div>
        <p>${oddsComparisonMarkup(latest, true)}</p>
        <p class="muted">${latest.charm && latest.method !== "fossil" ? "Shiny Charm" : "Base odds"} · 1 in ${odds} per check${latest.location ? ` · ${safe(latest.location)}` : ""}</p>
      </div>
    </div>`;
  }
  const scored = completed.filter((hunt) => oddsDifference(hunt) !== null);
  const lucky = scored.filter((hunt) => oddsDifference(hunt) < -0.05)
    .sort((a, b) => oddsDifference(a) - oddsDifference(b)).slice(0, 5);
  const unlucky = scored.filter((hunt) => oddsDifference(hunt) > 0.05)
    .sort((a, b) => oddsDifference(b) - oddsDifference(a)).slice(0, 5);
  $("#lowest-rates").innerHTML = renderRanking(lucky, "No below-odds catches yet. Your luckiest finds will appear here.");
  $("#highest-rates").innerHTML = renderRanking(unlucky, "No above-odds catches yet. Your longest hunts will appear here.");
}

function renderRanking(items, emptyMessage) {
  if (!items.length) return `<div class="empty">${emptyMessage}</div>`;
  return items.map((hunt, index) => `<div class="ranking-item">
    <span class="ranking-index">${index + 1}</span>
    ${imageTag(hunt.shinySprite || shinyIconUrl(hunt.pokemonId), `Shiny ${titleCase(hunt.name)}`)}
    <div class="ranking-details"><strong>${safe(titleCase(hunt.name))}</strong>
      <span class="muted-label">${number(hunt.checks)} / ${number(Math.round(expectedChecks(hunt)))} expected checks</span>
    </div>
    <span class="ranking-odds ${oddsDifference(hunt) < 0 ? "lucky" : "unlucky"}">${oddsDifference(hunt) < 0 ? "−" : "+"}${Math.abs(oddsDifference(hunt)).toFixed(1)}%</span>
  </div>`).join("");
}

function getFilteredDex() {
  const search = $("#dex-search").value.trim().toLowerCase();
  const filter = $("#dex-filter").value;
  const caughtIds = new Set(hunts.filter(h => h.status === "found").map(h => h.pokemonId));
  return ZA_DEX.filter(item => {
    const isCaught = caughtIds.has(item.pokemonId);
    if (filter === "available" && item.locked) return false;
    if (filter === "missing" && (item.locked || isCaught)) return false;
    if (filter === "collected" && (!isCaught || item.locked)) return false;
    if (filter === "locked" && !item.locked) return false;
    return !search || item.name.toLowerCase().includes(search) || String(item.number) === search || String(item.pokemonId) === search;
  });
}

function renderDex() {
  const collectable = ZA_DEX.filter(item => !item.locked);
  const counts = new Map();
  for (const hunt of hunts) if (hunt.status === "found") counts.set(hunt.pokemonId, (counts.get(hunt.pokemonId) || 0) + 1);
  const owned = collectable.filter(item => counts.has(item.pokemonId)).length;
  const percent = collectable.length ? 100 * owned / collectable.length : 0;
  $("#dex-total").textContent = `${owned} / ${collectable.length} collected`;
  $("#dex-progress-label").textContent = `${owned} of ${collectable.length} shiny species collected`;
  $("#dex-progress-percent").textContent = `${percent.toFixed(1)}%`;
  $("#dex-meter").setAttribute("aria-valuenow", percent.toFixed(1));
  $("#dex-meter-fill").style.width = `${percent}%`;

  const list = getFilteredDex();
  $("#dex-result-count").textContent = `Showing all ${list.length} matching entries. Images load as you scroll.`;
  $("#dex-grid").innerHTML = list.length ? list.map(item => {
    const ownedCount = counts.get(item.pokemonId) || 0;
    const state = item.locked ? "locked" : ownedCount ? "owned" : "missing";
    return `<button type="button" class="dex-card ${state}" data-dex-id="${item.pokemonId}" aria-label="${safe(item.name)}, regional number ${item.number}. ${item.locked ? "Shiny locked" : ownedCount ? `Collected, ${ownedCount} recorded` : "Not collected"}">
      <span class="dex-number">#${String(item.number).padStart(3, "0")}</span>
      <img src="${shinyIconUrl(item.pokemonId)}" alt="" loading="lazy" decoding="async">
      <strong>${safe(item.name)}</strong>
      <span class="dex-state">${item.locked ? "Shiny locked" : ownedCount ? `Collected${ownedCount > 1 ? ` ×${ownedCount}` : ""}` : "Not collected"}</span>
    </button>`;
  }).join("") : `<div class="empty">No Pokémon match those filters.</div>`;
}

function renderCollectionList() {
  const term = $("#collection-search").value.trim().toLowerCase();
  const order = $("#collection-sort").value;
  let found = hunts.filter(h => h.status === "found").filter(h =>
    [h.name, h.nickname, h.location].some(v => String(v || "").toLowerCase().includes(term)));
  if (order === "az") found.sort((a,b) => a.name.localeCompare(b.name));
  else if (order === "most") found.sort((a,b) => (b.checks || 0) - (a.checks || 0));
  else if (order === "fewest") found.sort((a,b) => (a.unknownChecks ? 1e12 : a.checks) - (b.unknownChecks ? 1e12 : b.checks));
  else found.sort((a,b) => (Date.parse(b.caughtAt || b.foundDate || 0) || 0) - (Date.parse(a.caughtAt || a.foundDate || 0) || 0));
  if (order === "oldest") found.reverse();
  $("#collection-count").textContent = `${found.length} matching collection records.`;
  $("#collection-grid").innerHTML = found.length ? found.map(renderCollectionItem).join("")
    : `<div class="empty">No matching shinies. Open the Pokédex to add one.</div>`;
}

function huntSummary(hunt) {
  return `<div class="hunt-details" style="padding:10px 0;border-top:1px solid var(--border)">
    <span><strong>${safe(titleCase(hunt.name))}</strong> <span class="muted-label">· ${hunt.status === "found" ? "Found" : "Hunting"}</span></span>
    <span class="muted-label">${number(hunt.checks)} checks</span></div>`;
}

function renderHunt(hunt) {
  const p = getProbabilityPerCheck(hunt);
  const cumulative = cumulativeChance(hunt.checks, p);
  const per = Math.round(1 / p);
  return `<article class="hunt-card">
    <div class="hunt-main">${imageTag(hunt.shinySprite, `Shiny ${titleCase(hunt.name)}`)}
      <div><h3>${safe(titleCase(hunt.name))}</h3><p>${hunt.charm ? "Shiny Charm active" : "Without Shiny Charm"} · ≈ 1 in ${number(per)} per check</p><p>Started ${safe(hunt.started || "previously")}</p></div></div>
    <div class="hunt-details"><div><span class="muted-label">Individual Pokemon checked</span><div class="hunt-count">${number(hunt.checks)}</div></div><div><span class="muted-label">Cumulative chance so far</span><div class="hunt-count">${cumulative.toFixed(1)}%</div></div></div>
    <div class="meter" role="progressbar" aria-label="Cumulative probability of at least one shiny" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${cumulative.toFixed(1)}"><span style="width:${cumulative}%"></span></div>
    <p class="hint">${oddsComparisonMarkup(hunt, true)} · Cumulative chance is not guaranteed progress.</p>
    <div class="hunt-actions">
      <button type="button" data-action="increment" data-id="${safe(hunt.id)}" data-amount="1">+1</button>
      <button type="button" data-action="increment" data-id="${safe(hunt.id)}" data-amount="5">+5</button>
      <button type="button" data-action="increment" data-id="${safe(hunt.id)}" data-amount="10">+10</button>
      <button type="button" class="outline" data-action="increment" data-id="${safe(hunt.id)}" data-amount="-1">Undo 1</button>
      <button type="button" class="outline" data-action="complete" data-id="${safe(hunt.id)}">Shiny found!</button>
      <button type="button" class="danger-outline" data-action="delete" data-id="${safe(hunt.id)}">Delete</button>
    </div>
  </article>`;
}

function renderCollectionItem(hunt) {
  return `<article class="collection-entry">
    ${imageTag(hunt.shinySprite, `Shiny ${titleCase(hunt.name)}`)}
    <strong>${safe(hunt.nickname || titleCase(hunt.name))}</strong>
    <p>${safe(titleCase(hunt.name))}</p>
    <p>${hunt.unknownChecks ? "Unknown checks" : `${number(hunt.checks)} checks`} · ${safe(hunt.foundDate || "Date unknown")}</p>
    <p>${oddsComparisonMarkup(hunt)}</p>
    ${hunt.location ? `<p>${safe(hunt.location)}</p>` : ""}
    <div class="collection-actions"><button type="button" class="outline small" data-action="edit-collection" data-id="${safe(hunt.id)}">Edit catch</button><button type="button" class="danger-outline small" data-action="delete" data-id="${safe(hunt.id)}">Remove</button></div>
  </article>`;
}

async function searchPokemon(input, targetId = "pokemon-result") {
  const clean = String(input).toLowerCase().trim().replace(/\s+/g, "-");
  if (!/^[a-z0-9-]{1,55}$/.test(clean)) {
    showStatus("Enter a Pokémon name or National Pokédex number.", true);
    return;
  }
  const matched = ZA_DEX.find(item => String(item.pokemonId) === clean || item.name.toLowerCase().replace(/\s+/g, "-") === clean);
  if (!matched) {
    $("#" + targetId).innerHTML = `<div class="empty">That Pokémon isn't in the base-game Lumiose Pokédex.</div>`;
    showStatus("Choose a Pokémon from the Legends: Z-A Pokédex.", true);
    return;
  }
  const target = $("#" + targetId);
  const thisLookup = ++lookupSequence;
  if (targetId === "dex-result" && !$("#dex-dialog").open) $("#dex-dialog").showModal();
  const searchButton = $("#search-button");
  if (targetId === "pokemon-result") searchButton.disabled = true;
  target.innerHTML = `<p class="muted">Loading ${safe(matched.name)} from PokéAPI...</p>`;
  showStatus("Loading Pokémon data...");
  try {
    const response = await fetch(POKEMON_API + matched.pokemonId);
    if (!response.ok) throw new Error("Could not load that Pokémon from PokéAPI. Try again.");
    const pokemon = await response.json();
    if (thisLookup !== lookupSequence) return;
    const details = {
      pokemonId: matched.pokemonId, name: matched.name,
      shinySprite: spriteFromPokemon(pokemon) || shinyIconUrl(matched.pokemonId),
      normalSprite: normalSpriteFromPokemon(pokemon)
    };
    selectedPokemon = details;
    const suffix = targetId === "dex-result" ? "dex" : "home";
    const isLocked = matched.locked;
    target.innerHTML = `<div class="pokemon-profile">
      <div class="panel-heading"><div><p class="eyebrow">LUMIOSE #${String(matched.number).padStart(3, "0")}</p><div class="pokemon-name">${safe(matched.name)} <span class="muted-label">National #${matched.pokemonId}</span></div></div>
      ${targetId === "dex-result" ? `<button type="button" class="outline small" data-close-dex>Close</button>` : ""}</div>
      <div class="sprite-row"><div class="sprite-box">${imageTag(details.normalSprite, `Normal ${matched.name}`)}<span>Normal</span></div>
        <div class="sprite-box">${imageTag(details.shinySprite, `Shiny ${matched.name}`)}<span>Shiny</span></div></div>
      <p class="type-summary"><strong>Types:</strong> ${safe(pokemon.types.map(t => titleCase(t.type.name)).join(" / "))}</p>
      <div class="species-facts" id="species-facts-${suffix}"><p class="muted">Loading species and evolution family from PokéAPI...</p></div>
      ${isLocked ? `<p class="locked-note">This species is shiny-locked in Z-A's available base-game encounters. It cannot be started as a valid Z-A shiny hunt.</p>` : `
      <form class="hunt-form" id="new-hunt-form-${suffix}">
        <div class="form-row"><div><label for="initial-checks-${suffix}">Checks already completed</label><input type="number" id="initial-checks-${suffix}" name="checks" min="0" max="1000000000" step="1" value="0" required></div>
        <div><label for="hunt-note-${suffix}">Hunting area (optional)</label><input id="hunt-note-${suffix}" name="location" maxlength="100" placeholder="e.g. Wild Zone 7"></div></div>
        <div><label for="hunt-method-${suffix}">Hunting method</label><select id="hunt-method-${suffix}" name="method"><option value="wild">Wild spawn / encounter</option>${[142,696,698].includes(matched.pokemonId) ? `<option value="fossil">Fossil restoration (base odds)</option>` : ""}</select></div>
        <p class="method-charm-note" id="method-charm-note-${suffix}">${settings.shinyCharm ? "Shiny Charm unlocked: wild hunts automatically receive boosted odds." : "Shiny Charm not unlocked: standard wild odds apply."} Fossil restoration always uses base odds.</p>
        <button type="submit">Start hunting ${safe(matched.name)}</button>
      </form>`}
      ${!isLocked ? `<button type="button" class="outline add-collection-btn" data-add-collection="${matched.pokemonId}">Already caught it? Add to collection</button>` : ""}</div>
      <p class="hint">Huntable species may still have shiny-locked gift or scripted encounters. Track valid wild encounters or applicable methods.</p>`;
    const form = target.querySelector("form.hunt-form");
    if (form) form.addEventListener("submit", event => createHunt(event, details));
    loadSpeciesFacts(matched.pokemonId, suffix, thisLookup);
    showStatus(`${matched.name} loaded successfully.`);
  } catch (error) {
    target.innerHTML = `<div class="empty">Unable to load this Pokémon. Check your internet connection and try again.</div>`;
    showStatus(error.message || "Pokémon search failed.", true);
  } finally {
    if (targetId === "pokemon-result") searchButton.disabled = false;
  }
}

function createHunt(event, pokemon) {
  event.preventDefault();
  const form = event.currentTarget;
  const checks = Number(form.elements.checks.value);
  if (!Number.isSafeInteger(checks) || checks < 0 || checks > 1e9) {
    showStatus("Enter a valid whole number of checks (0 to 1,000,000,000).", true);
    return;
  }
  const method = form.elements.method.value === "fossil" ? "fossil" : "wild";
  const charm = method !== "fossil" && settings.shinyCharm;
  hunts.push({
    id: uid(), pokemonId: pokemon.pokemonId, name: pokemon.name,
    shinySprite: pokemon.shinySprite, checks, charm, method,
    status: "active", started: today(), location: form.elements.location.value.trim(),
    nickname: "", foundDate: ""
  });
  save();
  if ($("#dex-dialog").open) $("#dex-dialog").close();
  setView("hunts");
  showStatus(`Started a shiny hunt for ${pokemon.name}.`);
}

function actOnHunt(button) {
  const action = button.dataset.action;
  const hunt = hunts.find((item) => item.id === button.dataset.id);
  if (!hunt) return;
  if (action === "increment" && hunt.status === "active") {
    const amount = Number(button.dataset.amount);
    hunt.checks = Math.min(1e9, Math.max(0, hunt.checks + amount));
    save(); render({updateDex:false});
    const selector = `button[data-action="increment"][data-id="${CSS.escape(hunt.id)}"][data-amount="${amount}"]`;
    document.querySelector(selector)?.focus({preventScroll:true});
  } else if (action === "complete" && hunt.status === "active") {
    completingHuntId = hunt.id;
    $("#complete-target").textContent = `Save your shiny ${titleCase(hunt.name)} to your collection.`;
    $("#caught-name").value = "";
    $("#caught-location").value = hunt.location || "";
    $("#complete-dialog").showModal();
  } else if (action === "edit-collection" && hunt.status === "found") {
    openRecordForm(hunt);
  } else if (action === "delete") {
    if (!confirm(`Remove ${titleCase(hunt.name)} from your ${hunt.status === "found" ? "collection" : "hunts"}?`)) return;
    hunts = hunts.filter((item) => item.id !== hunt.id);
    save(); render(); showStatus("Record removed.");
  }
}


async function loadSpeciesFacts(id, suffix, sequence) {
  const element = document.getElementById(`species-facts-${suffix}`);
  if (!element) return;
  try {
    const speciesResponse = await fetch(SPECIES_API + id);
    if (!speciesResponse.ok) throw new Error("Species lookup unavailable");
    const species = await speciesResponse.json();
    if (sequence !== lookupSequence || !element.isConnected) return;
    const enGenus = species.genera?.find(entry => entry.language.name === "en")?.genus || "Unknown genus";
    const flavour = species.flavor_text_entries?.find(entry => entry.language.name === "en")?.flavor_text?.replace(/\f|\n|\r/g, " ").replace(/\s+/g, " ").trim() || "No description available";
    element.innerHTML = `<div class="species-panel"><p><strong>Species:</strong> ${safe(enGenus)}</p><p class="muted">${safe(flavour)}</p><div class="evolution-line" id="evolution-line-${suffix}"><span class="muted">Loading evolution family...</span></div></div>`;
    const url = species.evolution_chain?.url || "";
    if (!/^https:\/\/pokeapi\.co\/api\/v2\/evolution-chain\/\d+\/?$/.test(url)) return;
    const chainResponse = await fetch(url);
    if (!chainResponse.ok) throw new Error("Evolution family unavailable");
    const chain = await chainResponse.json();
    if (sequence !== lookupSequence || !element.isConnected) return;
    const names = [];
    const walk = (node) => {
      if (!node || names.length > 30) return;
      names.push(titleCase(node.species.name));
      for (const branch of node.evolves_to || []) walk(branch);
    };
    walk(chain.chain);
    const evolution = document.getElementById(`evolution-line-${suffix}`);
    if (evolution) evolution.innerHTML = `<strong>Evolution family:</strong> ${names.map(safe).join(" → ")}<p class="hint">General species family; Z-A-specific evolution requirements may differ.</p>`;
  } catch {
    if (sequence !== lookupSequence || !element.isConnected) return;
    if (!element.querySelector('.species-panel')) element.innerHTML = `<p class="hint">Extra Pokédex details are temporarily unavailable; you can still start or record a hunt.</p>`;
    else {
      const evolution = element.querySelector('.evolution-line');
      if (evolution) evolution.innerHTML = `<span class="hint">Evolution family temporarily unavailable.</span>`;
    }
  }
}

function openRecordForm(pokemon) {
  const existing = pokemon.id && pokemon.status === "found" ? pokemon : null;
  recordPokemon = pokemon;
  editingRecordId = existing?.id || null;
  $("#record-title").textContent = existing ? "Edit your shiny catch" : "Add shiny to collection";
  $("#record-target").textContent = `${titleCase(pokemon.name)} · Legends: Z-A`;
  $("#record-date").max = today();
  $("#record-date").value = existing?.foundDate || today();
  $("#record-checks").value = existing && !existing.unknownChecks && existing.checks > 0 ? String(existing.checks) : "";
  $("#record-nickname").value = existing?.nickname || "";
  $("#record-location").value = existing?.location || "";
  $("#record-method").value = existing?.method === "fossil" ? "fossil" : "wild";
  $("#record-charm").checked = existing ? existing.charm : settings.shinyCharm;
  $("#record-dialog").showModal();
}
$("#cancel-record").addEventListener("click", () => $("#record-dialog").close());
$("#record-form").addEventListener("submit", event => {
  event.preventDefault();
  if (!recordPokemon) return;
  const field = $("#record-checks").value.trim();
  const checks = field ? Number(field) : 0;
  const unknownChecks = field === "";
  const date = $("#record-date").value;
  if (!(/^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date))) || date > today()) {
    showStatus("Enter a valid catch date.", true); return;
  }
  if ((!unknownChecks && (!Number.isSafeInteger(checks) || checks < 1 || checks > 1e9))) {
    showStatus("Use a positive whole number of checks, or leave this blank if unknown.", true); return;
  }
  const existing = editingRecordId ? hunts.find(h => h.id === editingRecordId) : null;
  const method = $("#record-method").value === "fossil" ? "fossil" : "wild";
  const data = {
    ...(existing || {}), id: existing?.id || uid(), pokemonId: recordPokemon.pokemonId,
    name: recordPokemon.name, shinySprite: existing?.shinySprite || shinyIconUrl(recordPokemon.pokemonId),
    status:"found", started: existing?.started || date, foundDate: date,
    caughtAt: `${date}T12:00:00`, checks, unknownChecks,
    nickname: $("#record-nickname").value.trim(), location: $("#record-location").value.trim(),
    method, charm: method === "fossil" ? false : $("#record-charm").checked,
    manual: existing?.manual ?? true
  };
  if (existing) Object.assign(existing, data);
  else hunts.push(data);
  save(); $("#record-dialog").close();
  if (!existing && activeView === "pokedex") renderDex();
  render();
  showStatus(`${titleCase(data.name)} ${existing ? "updated" : "added to your collection"}.`);
});

$("#search-form").addEventListener("submit", (event) => {
  event.preventDefault(); searchPokemon($("#pokemon-search").value);
});
document.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.view) setView(button.dataset.view);
  if (button.dataset.pick) {
    $("#pokemon-search").value = button.dataset.pick;
    searchPokemon(button.dataset.pick);
  }
  if (button.dataset.action) actOnHunt(button);
  if (button.dataset.dexId) searchPokemon(button.dataset.dexId, "dex-result");
  if (button.dataset.addCollection) {
    const species = ZA_DEX_BY_ID.get(Number(button.dataset.addCollection));
    if (species && !species.locked) {
      if ($("#dex-dialog").open) $("#dex-dialog").close();
      openRecordForm({pokemonId: species.pokemonId, name: species.name});
    }
  }
  if (button.hasAttribute("data-close-dex")) $("#dex-dialog").close();
});
$("#dex-search").addEventListener("input", renderDex);
$("#dex-filter").addEventListener("change", renderDex);
$("#collection-search").addEventListener("input", renderCollectionList);
$("#collection-sort").addEventListener("change", renderCollectionList);
$("#add-collection").addEventListener("click", () => {
  setView("pokedex");
  $("#dex-search").focus({preventScroll:true});
});
$("#global-charm").addEventListener("change", (event) => {
  settings.shinyCharm = event.target.checked;
  saveSettings(); updateCharmDisplay();
  showStatus(settings.shinyCharm ? "Shiny Charm unlocked. Future wild hunts will use boosted odds." : "Shiny Charm disabled for future hunts. Existing hunt odds are unchanged.");
});
$("#dex-dialog").addEventListener("close", () => {lookupSequence++; $("#dex-result").innerHTML = "";});
$("#cancel-complete").addEventListener("click", () => $("#complete-dialog").close());
$("#complete-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const hunt = hunts.find((item) => item.id === completingHuntId && item.status === "active");
  if (!hunt) return;
  hunt.status = "found";
  hunt.foundDate = today();
  hunt.caughtAt = new Date().toISOString();
  hunt.nickname = $("#caught-name").value.trim();
  hunt.location = $("#caught-location").value.trim();
  save();
  $("#complete-dialog").close();
  completingHuntId = null;
  setView("dashboard");
  showStatus(`${titleCase(hunt.name)} added to your shiny collection and dashboard!`);
});
$("#export-btn").addEventListener("click", () => {
  const contents = JSON.stringify({app: "ShinyQuest ZA", version: 1, exported: today(), settings, hunts}, null, 2);
  const url = URL.createObjectURL(new Blob([contents], {type: "application/json"}));
  const link = document.createElement("a");
  link.href = url; link.download = `shinyquest-za-${today()}.json`;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showStatus("Backup exported.");
});
$("#import-file").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    if (file.size > 2_000_000) throw new Error("Import file must be below 2 MB.");
    const parsed = JSON.parse(await file.text());
    if (parsed.app !== "ShinyQuest ZA" || parsed.version !== 1 || !Array.isArray(parsed.hunts) ||
        parsed.hunts.length > 10000 || !parsed.hunts.every(isValidHunt)) {
      throw new Error("That is not a valid ShinyQuest Z-A backup.");
    }
    if (!confirm("Replace all current hunts and collection entries with this backup?")) return;
    hunts = parsed.hunts;
    if (parsed.settings && typeof parsed.settings.shinyCharm === "boolean") {
      settings.shinyCharm = parsed.settings.shinyCharm;
      saveSettings(); updateCharmDisplay();
    }
    save(); render(); showStatus("Backup imported.");
  } catch (error) { showStatus(error.message || "Could not import backup.", true); }
  finally { event.target.value = ""; }
});
$("#clear-btn").addEventListener("click", () => {
  if (!confirm("Permanently delete ALL hunts and collected shinies saved in this browser? Export a backup first.")) return;
  hunts = []; save(); render(); showStatus("All local data cleared.");
});

updateCharmDisplay();
render();
