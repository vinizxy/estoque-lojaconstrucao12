const { createClient } = supabase;
const $ = (sel) => document.querySelector(sel);

let db;
try {
  db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
} catch (err) {
  db = null;
}

function showConfigError() {
  $('#login-error').textContent =
    'Configuração do Supabase ausente ou inválida em config.js (veja o README).';
}

async function redirectIfLoggedIn() {
  if (!db) return;
  const { data: { session } } = await db.auth.getSession();
  if (session) {
    window.location.href = 'index.html';
  }
}

let submitting = false;

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (submitting) return;

  $('#login-error').textContent = '';

  if (!db) {
    showConfigError();
    return;
  }

  submitting = true;
  $('#login-submit').disabled = true;
  $('#login-submit').textContent = 'Entrando…';

  const email = $('#login-email').value.trim();
  const password = $('#login-password').value;

  const { error } = await db.auth.signInWithPassword({ email, password });

  if (error) {
    submitting = false;
    $('#login-submit').disabled = false;
    $('#login-submit').textContent = 'Entrar';
    $('#login-error').textContent = 'Email ou senha inválidos.';
    return;
  }

  window.location.href = 'index.html';
});

redirectIfLoggedIn();
