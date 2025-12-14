// This is the only place you need to import the Supabase library
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';

// --- Configuration: Connect to Supabase ---
// IMPORTANT: These variables will be injected by Cloudflare Pages securely!
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Fallback for local testing if not running through Cloudflare
if (!SUPABASE_URL) {
    console.error("SUPABASE_URL not found. Ensure environment variables are set in Cloudflare.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// --- DOM Elements ---
const startSessionBtn = document.getElementById('start-session-btn');
const receiptCodeInput = document.getElementById('receipt-code');
const durationSelect = document.getElementById('duration-select');
const activeCarsList = document.getElementById('active-cars-list');
const availableCarsList = document.getElementById('available-cars-list');
const nextTimerDisplay = document.getElementById('next-timer');
const timeUpOverlay = document.getElementById('time-up-overlay');
const timeUpCarNumber = document.getElementById('time-up-car-number');

// --- Helper Functions ---

/**
 * Formats milliseconds into M:SS string.
 */
function formatTime(ms) {
    if (ms <= 0) return '0:00';
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * Calculates time remaining and updates the card display.
 * Also checks if the timer is up for the customer display.
 */
function updateTimerDisplay(rental) {
    const endTime = new Date(rental.end_time).getTime();
    const now = new Date().getTime();
    const timeLeftMs = endTime - now;
    
    const cardTimerElement = document.querySelector(`#car-timer-${rental.car_id}`);
    
    if (cardTimerElement) {
        cardTimerElement.textContent = formatTime(timeLeftMs);
    }

    // Customer Notification Logic:
    if (timeLeftMs <= 0 && rental.status === 'ACTIVE') {
        timeUpCarNumber.textContent = `CAR #${rental.car_id}`;
        timeUpOverlay.classList.remove('hidden');
    } else if (timeUpCarNumber.textContent === `CAR #${rental.car_id}`) {
        // If the car has been reset, hide the overlay
        timeUpOverlay.classList.add('hidden');
    }
}


// --- Main Data Fetching and Rendering ---

/**
 * Fetches all car and rental data and renders the dashboard.
 */
async function renderDashboard() {
    // We use a join query to get all cars and their active rental data (if any)
    const { data: cars, error } = await supabase
        .from('cars')
        .select(`
            id,
            is_available,
            rental_id,
            rentals (
                id,
                end_time,
                status
            )
        `)
        .order('id', { ascending: true });

    if (error) {
        console.error("Error fetching dashboard data:", error);
        return;
    }

    activeCarsList.innerHTML = '';
    availableCarsList.innerHTML = '';
    
    let nextAvailableTime = null;
    let activeRentals = [];

    cars.forEach(car => {
        if (car.is_available) {
            // Render Available Cars
            availableCarsList.innerHTML += `<div class="car-available">Car #${car.id}</div>`;
        } else {
            // Render Active Cars
            const rental = Array.isArray(car.rentals) ? car.rentals[0] : car.rentals;
            
            if (rental && rental.status === 'ACTIVE') {
                activeRentals.push({ car_id: car.id, end_time: rental.end_time, status: rental.status });
                
                // Check for the next available car time
                const endTimeMs = new Date(rental.end_time).getTime();
                if (nextAvailableTime === null || endTimeMs < nextAvailableTime) {
                    nextAvailableTime = endTimeMs;
                }

                // Render the car card for the worker
                activeCarsList.innerHTML += `
                    <div class="car-card">
                        <h3>Car #${car.id}</h3>
                        <p>Time Left: <strong id="car-timer-${car.id}">...</strong></p>
                        <button onclick="resetSession(${car.id})">Reset</button>
                    </div>
                `;
            }
        }
    });

    if (activeRentals.length === 0) {
        activeCarsList.innerHTML = '<p>No active sessions.</p>';
        nextTimerDisplay.textContent = 'N/A';
    }

    if (cars.every(car => !car.is_available)) {
        availableCarsList.innerHTML = '<p>All cars in use.</p>';
    }
    
    // Start interval for timer updates
    startClientTimers(activeRentals, nextAvailableTime);
}

// --- Real-time Timer Interval ---
let timerInterval = null;

function startClientTimers(activeRentals, nextAvailableTime) {
    // Clear previous interval
    if (timerInterval) clearInterval(timerInterval);

    // Set a new interval to update all timers every second
    timerInterval = setInterval(() => {
        const now = new Date().getTime();

        // 1. Update individual car timers and check for TIME UP
        activeRentals.forEach(rental => {
            updateTimerDisplay(rental);
        });

        // 2. Update the Next Available Timer
        if (nextAvailableTime) {
            const nextTimeLeft = nextAvailableTime - now;
            nextTimerDisplay.textContent = formatTime(nextTimeLeft);
        }
        
    }, 1000);
}


// --- Worker Actions (RPC Calls) ---

/**
 * Worker action to start a new rental session.
 */
async function startSession() {
    const receiptCode = receiptCodeInput.value.trim();
    const durationMinutes = parseInt(durationSelect.value);

    if (!receiptCode) {
        alert('Please enter a receipt code.');
        return;
    }
    
    try {
        // Call the Supabase function
        const { data: assignedCarId, error } = await supabase.rpc('start_rental_session', {
            _receipt_code: receiptCode,
            _duration_minutes: durationMinutes,
        });

        if (error) {
            alert(`Error: ${error.message}`);
            console.error(error);
            return;
        }

        alert(`Success! Car #${assignedCarId} assigned for ${durationMinutes} minutes.`);
        receiptCodeInput.value = ''; // Clear input

    } catch (e) {
        alert(`An unexpected error occurred: ${e.message}`);
    }
}

/**
 * Worker action to end a rental session (exposed globally via window object).
 */
window.resetSession = async function(carId) {
    if (!confirm(`Confirm Car #${carId} is being reset and marked available?`)) {
        return;
    }
    
    try {
        // Call the Supabase function
        const { error } = await supabase.rpc('end_rental_session', {
            _car_id: carId,
        });

        if (error) {
            alert(`Error resetting session: ${error.message}`);
            console.error(error);
            return;
        }

        alert(`Car #${carId} successfully reset.`);

    } catch (e) {
        alert(`An unexpected error occurred: ${e.message}`);
    }
};


// --- Initialization ---

document.addEventListener('DOMContentLoaded', () => {
    // Initial load of the dashboard
    renderDashboard();

    // Set up Realtime Subscription
    // When a change occurs in cars or rentals, re-render the whole dashboard
    supabase
      .channel('timer_dashboard')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cars' }, () => {
        console.log('Realtime change: Refreshing dashboard...');
        renderDashboard();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rentals' }, () => {
        console.log('Realtime change: Refreshing dashboard...');
        renderDashboard();
      })
      .subscribe();

    // Event Listener for the Start Button
    startSessionBtn.addEventListener('click', startSession);
});