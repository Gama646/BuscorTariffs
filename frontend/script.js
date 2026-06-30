// Fully interactive Buscor Ticket purchasing frontend script

// 3D Card Flip Handler
const cardFlipContainer = document.getElementById('cardFlipContainer');
if (cardFlipContainer) {
  cardFlipContainer.addEventListener('click', function() {
    this.classList.toggle('flipped');
  });
}

const areaSelect = document.getElementById('areaSelect');
const fromSelect = document.getElementById('fromSelect');
const toSelect = document.getElementById('toSelect');
const ticketTypeSelect = document.getElementById('ticketTypeSelect');
const payButton = document.getElementById('payButton');
const summaryText = document.getElementById('summaryText');
const resetButton = document.getElementById('resetButton');
const fareTableBody = document.getElementById('fareTableBody');
const routeSearch = document.getElementById('routeSearch');
const ticketFilter = document.getElementById('ticketFilter');
const areaButtons = document.querySelectorAll('.chip');
const priceDisplay = document.getElementById('priceDisplay');
const cardNumberInput = document.getElementById('cardNumber');
const validateCardButton = document.getElementById('validateCardButton');
const cardStatus = document.getElementById('cardStatus');

// Pagination elements
const prevPageBtn = document.getElementById('prevPageBtn');
const nextPageBtn = document.getElementById('nextPageBtn');
const pageLabel = document.getElementById('pageLabel');
const pageInfo = document.getElementById('pageInfo');

let trips = [];
let cardValid = false;
let validatedAlias = '';
let activeArea = 'All Areas';
const pageSize = 8;
let currentPage = 1;

// Load trips from backend
async function loadTrips() {
  try {
    const res = await fetch('/api/trips');
    const data = await res.json();
    trips = data.trips || [];
    populateAreas();
    refreshTripChoices();
    renderTrips();
  } catch (err) {
    console.error('Failed to load trips', err);
  }
}

// Populate the Area dropdown in the payment form
function populateAreas() {
  const areas = ['All Areas', ...new Set(trips.map(t => t.area))];
  areaSelect.innerHTML = areas.map(a => `<option value="${a}">${a}</option>`).join('');
}

// Refresh choices for From, To, and Ticket Types
function refreshTripChoices() {
  const selectedArea = areaSelect.value || 'All Areas';
  
  // Filter trips for selected area
  const areaTrips = trips.filter(t => selectedArea === 'All Areas' || t.area === selectedArea);
  
  // Unique "from" locations
  const fromOptions = [...new Set(areaTrips.map(t => t.from))].sort();
  fromSelect.innerHTML = fromOptions.map(f => `<option value="${f}">${f}</option>`).join('');
  
  // Get currently selected "from"
  const currentFrom = fromSelect.value || fromOptions[0] || '';
  
  // Filter trips matching this "from"
  const matchingFromTrips = areaTrips.filter(t => t.from === currentFrom);
  
  // Unique "to" locations for this "from"
  const toOptions = [...new Set(matchingFromTrips.map(t => t.to))].sort();
  toSelect.innerHTML = toOptions.map(t => `<option value="${t}">${t}</option>`).join('');
  
  // Get currently selected "to"
  const currentTo = toSelect.value || toOptions[0] || '';
  
  // Populate ticket types for this specific (from, to) route
  updateTicketOptions(currentFrom, currentTo, selectedArea);
}

// Update ticket types select
function updateTicketOptions(from, to, area) {
  const matchingRouteTrips = trips.filter(t => t.from === from && t.to === to && (area === 'All Areas' || t.area === area));
  
  const options = matchingRouteTrips.map(t => {
    const priceStr = String(t.price || '').replace('R', '').trim();
    return {
      label: t.ticketType,
      price: priceStr,
      value: `${t.ticketType}|${priceStr}`
    };
  });
  
  ticketTypeSelect.innerHTML = options.map(o => `<option value="${o.value}">${o.label} - R${o.price}</option>`).join('');
  
  updatePriceDisplay();
}

// Update the price display and summary
function updatePriceDisplay() {
  const val = ticketTypeSelect.value;
  if (val) {
    const [type, price] = val.split('|');
    priceDisplay.textContent = `R${price}`;
    
    // Update summary text if card is validated
    if (cardValid) {
      summaryText.textContent = `Card Holder: ${validatedAlias} | Route: ${fromSelect.value} to ${toSelect.value} | Ticket: ${type} | Amount: R${price}`;
    }
  } else {
    priceDisplay.textContent = 'Price will update here.';
  }
}

// Get filtered list of trips for the live table
function getVisibleTrips() {
  const search = (routeSearch.value || '').toLowerCase();
  const filterType = ticketFilter.value;
  
  return trips.filter(trip => {
    if (activeArea !== 'All Areas' && trip.area !== activeArea) return false;
    if (filterType !== 'All' && trip.ticketType !== filterType) return false;
    if (search) {
      return (trip.from + ' ' + trip.to).toLowerCase().includes(search);
    }
    return true;
  });
}

// Render the live fare table with pagination
function renderTrips() {
  const visible = getVisibleTrips();
  const totalItems = visible.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  
  // Bound check page
  if (currentPage > totalPages) currentPage = totalPages;
  if (currentPage < 1) currentPage = 1;
  
  const start = (currentPage - 1) * pageSize;
  const pageTrips = visible.slice(start, start + pageSize);
  
  // Show totals
  if (pageInfo) {
    pageInfo.textContent = `Showing ${totalItems > 0 ? start + 1 : 0} - ${Math.min(start + pageSize, totalItems)} of ${totalItems} routes`;
  }
  if (pageLabel) {
    pageLabel.textContent = `Page ${currentPage} of ${totalPages}`;
  }
  
  // Update button disabled state
  if (prevPageBtn) prevPageBtn.disabled = currentPage === 1;
  if (nextPageBtn) nextPageBtn.disabled = currentPage === totalPages;
  
  fareTableBody.innerHTML = pageTrips.map(t => `
    <tr>
      <td>${t.from}</td>
      <td>${t.to}</td>
      <td>${t.ticketType}</td>
      <td>${t.price}</td>
      <td>-</td>
      <td>
        <button class="ghost-btn select-trip-btn" onclick="selectRoute('${t.area}', '${t.from.replace(/'/g, "\\'")}', '${t.to.replace(/'/g, "\\'")}', '${t.ticketType}', '${t.price}')">Select</button>
      </td>
    </tr>
  `).join('');
}

// Select route from the live table to populate payment form
window.selectRoute = function(area, from, to, ticketType, price) {
  // If card is not validated, alert user
  if (!cardValid) {
    alert("Please enter and validate your Alias Number first before selecting a trip.");
    cardNumberInput.focus();
    cardNumberInput.scrollIntoView({ behavior: 'smooth' });
    return;
  }
  
  areaSelect.value = area;
  refreshTripChoices(); // Re-populate from and to selects based on area
  
  fromSelect.value = from;
  // Trigger change manually to re-populate toSelect and ticket types
  const selectedArea = areaSelect.value || 'All Areas';
  const areaTrips = trips.filter(t => selectedArea === 'All Areas' || t.area === selectedArea);
  const matchingFromTrips = areaTrips.filter(t => t.from === from);
  const toOptions = [...new Set(matchingFromTrips.map(t => t.to))].sort();
  toSelect.innerHTML = toOptions.map(t => `<option value="${t}">${t}</option>`).join('');
  toSelect.value = to;
  
  // Trigger update ticket options
  updateTicketOptions(from, to, area);
  
  // Select matching ticket type
  const priceClean = price.replace('R', '').trim();
  ticketTypeSelect.value = `${ticketType}|${priceClean}`;
  updatePriceDisplay();
  
  // Scroll to payment form
  document.getElementById('payment-chooser').scrollIntoView({ behavior: 'smooth' });
};

// Enable/Disable form controls based on card validation
function setPaymentControlsState(enabled) {
  areaSelect.disabled = !enabled;
  fromSelect.disabled = !enabled;
  toSelect.disabled = !enabled;
  ticketTypeSelect.disabled = !enabled;
  payButton.disabled = !enabled;
}

function updateCardStatus(message, valid = false) {
  cardValid = valid;
  cardStatus.textContent = message;
  cardStatus.classList.toggle('valid', valid);
  cardStatus.classList.toggle('invalid', !valid);
  setPaymentControlsState(valid);
  
  if (!valid) {
    summaryText.textContent = "Choose a route and ticket type to see your payment summary.";
  } else {
    updatePriceDisplay();
  }
}

// Add Event Listeners
areaSelect.addEventListener('change', () => {
  refreshTripChoices();
});

fromSelect.addEventListener('change', () => {
  const selectedArea = areaSelect.value || 'All Areas';
  const currentFrom = fromSelect.value;
  const areaTrips = trips.filter(t => selectedArea === 'All Areas' || t.area === selectedArea);
  const matchingFromTrips = areaTrips.filter(t => t.from === currentFrom);
  const toOptions = [...new Set(matchingFromTrips.map(t => t.to))].sort();
  toSelect.innerHTML = toOptions.map(t => `<option value="${t}">${t}</option>`).join('');
  const currentTo = toSelect.value || toOptions[0] || '';
  updateTicketOptions(currentFrom, currentTo, selectedArea);
});

toSelect.addEventListener('change', () => {
  updateTicketOptions(fromSelect.value, toSelect.value, areaSelect.value);
});

ticketTypeSelect.addEventListener('change', () => {
  updatePriceDisplay();
});

// Search and filtering
routeSearch.addEventListener('input', () => {
  currentPage = 1;
  renderTrips();
});

ticketFilter.addEventListener('change', () => {
  currentPage = 1;
  renderTrips();
});

// Area Chips
areaButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    areaButtons.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeArea = btn.getAttribute('data-area') || 'All Areas';
    currentPage = 1;
    renderTrips();
  });
});

// Pagination
prevPageBtn?.addEventListener('click', () => {
  if (currentPage > 1) {
    currentPage--;
    renderTrips();
  }
});

nextPageBtn?.addEventListener('click', () => {
  currentPage++;
  renderTrips();
});

// Alias validation
validateCardButton?.addEventListener('click', async () => {
  const alias = cardNumberInput.value.trim();
  if (!alias) return updateCardStatus('Enter alias number', false);
  try {
    const res = await fetch('/api/cards/validate', { 
      method: 'POST', 
      headers: { 'Content-Type': 'application/json' }, 
      body: JSON.stringify({ aliasNo: alias }) 
    });
    const data = await res.json();
    if (data && data.valid) {
      validatedAlias = alias;
      updateCardStatus('Alias valid', true);
    } else {
      updateCardStatus(data.message || 'Alias invalid', false);
    }
  } catch (err) {
    console.error(err);
    updateCardStatus('Validation error', false);
  }
});

// Real payment flow via PayFast
payButton?.addEventListener('click', async () => {
  if (!cardValid) return alert('Validate alias first');

  const val = ticketTypeSelect.value;
  if (!val) return alert('Select a ticket type');

  const [ticketType] = val.split('|');
  const to = toSelect.value;
  const from = fromSelect.value;
  const area = areaSelect.value;

  const resultContainer = document.getElementById('result');
  if (resultContainer) {
    resultContainer.innerHTML = '<div class="info-box">Preparing your payment…</div>';
  }

  if (typeof window.startPayment === 'function') {
    await window.startPayment(validatedAlias, area, from, to, ticketType);
  } else {
    alert('Payment flow is unavailable right now.');
  }
});

// Reset
resetButton?.addEventListener('click', () => {
  cardNumberInput.value = '';
  updateCardStatus('Enter your Alias number, then validate before selecting a trip.', false);
  priceDisplay.textContent = 'Price will update here.';
  refreshTripChoices();
});

// Init
document.addEventListener('DOMContentLoaded', () => {
  loadTrips();
});
