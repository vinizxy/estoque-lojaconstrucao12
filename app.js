const { createClient } = supabase;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let db;
try {
  db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
} catch (err) {
  db = null;
}

// Só chama o callback uma vez por clique/submit, mesmo se o usuário clicar
// de novo (ou o navegador disparar o evento mais de uma vez) antes da
// requisição anterior terminar — evita registros duplicados no banco.
function guardAgainstDoubleSubmit(button, handler) {
  let submitting = false;
  return async (e) => {
    if (e && e.preventDefault) e.preventDefault();
    if (submitting) return;
    submitting = true;
    const originalText = button.textContent;
    button.disabled = true;
    try {
      await handler(e);
    } finally {
      submitting = false;
      button.disabled = false;
      button.textContent = originalText;
    }
  };
}

let products = [];
let suppliers = [];
let stockEntries = [];
let sales = [];
let saleItems = [];
let stockMovements = [];
let selectedSupplierId = null;

function formatMoney(value) {
  return Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatQty(value) {
  return Number(value || 0).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
}

function formatDate(isoDate) {
  if (!isoDate) return '—';
  const [y, m, d] = isoDate.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function productName(id) {
  return products.find((p) => p.id === id)?.name ?? '—';
}

function supplierName(id) {
  return suppliers.find((s) => s.id === id)?.name ?? '—';
}

// ---------- AUTH ----------

async function checkSession() {
  if (!db) {
    alert('Configuração do Supabase ausente ou inválida em config.js (veja o README).');
    return;
  }
  const { data: { session } } = await db.auth.getSession();
  if (!session) {
    window.location.href = 'login.html';
    return;
  }
  $('#app').hidden = false;
  loadAll();
}

db?.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT') {
    window.location.href = 'login.html';
  }
});

$('#btn-logout').addEventListener('click', async () => {
  await db.auth.signOut();
  window.location.href = 'login.html';
});

// ---------- DATA LOADING ----------

async function loadAll() {
  const [productsRes, suppliersRes, entriesRes, salesRes, saleItemsRes, movementsRes] = await Promise.all([
    db.from('products').select('*').order('name'),
    db.from('suppliers').select('*').order('name'),
    db.from('stock_entries').select('*').order('entry_date', { ascending: false }).order('created_at', { ascending: false }),
    db.from('sales').select('*').order('sold_at', { ascending: false }),
    db.from('sale_items').select('*'),
    db.from('stock_movements').select('*').order('created_at', { ascending: false }),
  ]);

  const firstError = productsRes.error || suppliersRes.error || entriesRes.error
    || salesRes.error || saleItemsRes.error || movementsRes.error;

  if (firstError) {
    console.error(firstError);
    $('#conn-status').textContent = 'erro de conexão';
    return;
  }

  products = productsRes.data;
  suppliers = suppliersRes.data;
  stockEntries = entriesRes.data;
  sales = salesRes.data;
  saleItems = saleItemsRes.data;
  stockMovements = movementsRes.data;

  $('#conn-status').textContent = 'conectado';

  renderDashboard();
  renderProdutos();
  renderFornecedores();
  renderCompras();
  renderAjustes();
  renderRelatorios();
  fillProductSelects();
  fillSupplierSelects();
}

// ---------- NAVIGATION ----------

$$('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.nav-item').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    $$('.view').forEach((v) => v.classList.remove('active'));
    $(`#view-${btn.dataset.view}`).classList.add('active');
    closeSidebar();
  });
});

function openSidebar() {
  $('#sidebar').classList.add('open');
  $('#sidebar-overlay').classList.add('open');
}
function closeSidebar() {
  $('#sidebar').classList.remove('open');
  $('#sidebar-overlay').classList.remove('open');
}
$('#menu-toggle').addEventListener('click', openSidebar);
$('#sidebar-overlay').addEventListener('click', closeSidebar);

// ---------- DASHBOARD ----------

function renderDashboard() {
  const valorEstoque = products.reduce((sum, p) => sum + Number(p.current_stock) * Number(p.avg_cost), 0);
  $('#stat-valor-estoque').textContent = formatMoney(valorEstoque);

  const today = todayISO();
  const monthPrefix = today.slice(0, 7);

  const vendasHoje = sales.filter((s) => s.sold_at.slice(0, 10) === today);
  const vendasMes = sales.filter((s) => s.sold_at.slice(0, 7) === monthPrefix);

  $('#stat-vendas-hoje').textContent = formatMoney(vendasHoje.reduce((sum, s) => sum + Number(s.total), 0));
  $('#stat-vendas-mes').textContent = formatMoney(vendasMes.reduce((sum, s) => sum + Number(s.total), 0));

  const abaixoDoMinimo = products.filter((p) => p.active && Number(p.current_stock) < Number(p.min_stock));
  $('#stat-estoque-baixo').textContent = abaixoDoMinimo.length;

  const alertaBody = $('#alerta-estoque-body');
  alertaBody.innerHTML = '';
  if (abaixoDoMinimo.length === 0) {
    alertaBody.innerHTML = '<tr><td colspan="4" class="muted">Nenhum produto abaixo do mínimo.</td></tr>';
  } else {
    abaixoDoMinimo.forEach((p) => {
      alertaBody.innerHTML += `
        <tr class="row-alert">
          <td>${p.name}</td>
          <td>${formatQty(p.current_stock)}</td>
          <td>${formatQty(p.min_stock)}</td>
          <td>${p.unit}</td>
        </tr>`;
    });
  }

  const vendasMesIds = new Set(vendasMes.map((s) => s.id));
  const itensDoMes = saleItems.filter((it) => vendasMesIds.has(it.sale_id));
  const porProduto = {};
  itensDoMes.forEach((it) => {
    if (!porProduto[it.product_id]) porProduto[it.product_id] = { qty: 0, total: 0 };
    porProduto[it.product_id].qty += Number(it.quantity);
    porProduto[it.product_id].total += Number(it.quantity) * Number(it.unit_price);
  });

  const maisVendidos = Object.entries(porProduto)
    .sort((a, b) => b[1].qty - a[1].qty)
    .slice(0, 8);

  const maisVendidosBody = $('#mais-vendidos-body');
  maisVendidosBody.innerHTML = '';
  if (maisVendidos.length === 0) {
    maisVendidosBody.innerHTML = '<tr><td colspan="3" class="muted">Nenhuma venda neste mês.</td></tr>';
  } else {
    maisVendidos.forEach(([productId, agg]) => {
      maisVendidosBody.innerHTML += `
        <tr>
          <td>${productName(productId)}</td>
          <td>${formatQty(agg.qty)}</td>
          <td>${formatMoney(agg.total)}</td>
        </tr>`;
    });
  }
}

// ---------- SELECTS ----------

function fillProductSelects() {
  const active = products.filter((p) => p.active);
  const options = '<option value="">Selecione o produto</option>' +
    active.map((p) => `<option value="${p.id}">${p.name} (${p.unit})</option>`).join('');
  $('#compra-produto').innerHTML = options;
  $('#venda-produto').innerHTML = options;
  $('#ajuste-produto').innerHTML = options;
}

function fillSupplierSelects() {
  $('#compra-fornecedor').innerHTML = '<option value="">Selecione o fornecedor</option>' +
    suppliers.map((s) => `<option value="${s.id}">${s.name}</option>`).join('');
}

// ---------- PRODUTOS ----------

function renderProdutos(filter = '') {
  const tbody = $('#produtos-table-body');
  tbody.innerHTML = '';
  const f = filter.toLowerCase();
  const filtered = products.filter(
    (p) => p.name.toLowerCase().includes(f) || (p.category || '').toLowerCase().includes(f)
  );

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="muted">Nenhum produto encontrado.</td></tr>';
    return;
  }

  filtered.forEach((p) => {
    tbody.innerHTML += `
      <tr class="${!p.active ? 'muted' : ''}">
        <td>${p.name}${!p.active ? ' (inativo)' : ''}</td>
        <td class="hide-mobile">${p.category || '—'}</td>
        <td>${p.unit}</td>
        <td>${formatQty(p.current_stock)}</td>
        <td class="hide-mobile">${formatQty(p.min_stock)}</td>
        <td>${formatMoney(p.avg_cost)}</td>
        <td>${formatMoney(p.sale_price)}</td>
        <td><button class="icon-btn edit-produto-btn" data-id="${p.id}">Editar</button></td>
      </tr>`;
  });

  $$('.edit-produto-btn').forEach((btn) => {
    btn.addEventListener('click', () => openModalProduto(btn.dataset.id));
  });
}

$('#search-produtos').addEventListener('input', (e) => renderProdutos(e.target.value));

let editingProductId = null;

function openModalProduto(id = null) {
  editingProductId = id;
  const product = id ? products.find((p) => p.id === id) : null;

  $('#modal-produto-titulo').textContent = product ? 'Editar produto' : 'Novo produto';
  $('#modal-produto-nome').value = product?.name || '';
  $('#modal-produto-categoria').value = product?.category || '';
  $('#modal-produto-unidade').value = product?.unit || '';
  $('#modal-produto-minimo').value = product?.min_stock ?? 0;
  $('#modal-produto-preco').value = product?.sale_price ?? 0;
  $('#modal-produto-error').textContent = '';

  $('#modal-produto-ativo-wrap').hidden = !product;
  $('#modal-produto-ativo').checked = product ? product.active : true;

  $('#modal-produto-overlay').classList.add('open');
  $('#modal-produto').classList.add('open');
}

function closeModalProduto() {
  $('#modal-produto-overlay').classList.remove('open');
  $('#modal-produto').classList.remove('open');
}

$('#btn-novo-produto').addEventListener('click', () => openModalProduto(null));
$('#modal-produto-cancel').addEventListener('click', closeModalProduto);
$('#modal-produto-overlay').addEventListener('click', closeModalProduto);

$('#modal-produto-confirm').addEventListener('click', guardAgainstDoubleSubmit($('#modal-produto-confirm'), async () => {
  const name = $('#modal-produto-nome').value.trim();
  const category = $('#modal-produto-categoria').value.trim();
  const unit = $('#modal-produto-unidade').value.trim();
  const minStock = parseFloat($('#modal-produto-minimo').value);
  const salePrice = parseFloat($('#modal-produto-preco').value);

  if (!name || !unit || Number.isNaN(minStock) || Number.isNaN(salePrice)) {
    $('#modal-produto-error').textContent = 'Preencha nome, unidade, mínimo e preço.';
    return;
  }
  if (minStock < 0 || salePrice < 0) {
    $('#modal-produto-error').textContent = 'Mínimo e preço não podem ser negativos.';
    return;
  }

  const payload = { name, category: category || null, unit, min_stock: minStock, sale_price: salePrice };

  let error;
  if (editingProductId) {
    payload.active = $('#modal-produto-ativo').checked;
    ({ error } = await db.from('products').update(payload).eq('id', editingProductId));
  } else {
    ({ error } = await db.from('products').insert(payload));
  }

  if (error) {
    $('#modal-produto-error').textContent = 'Erro ao salvar: ' + error.message;
    return;
  }

  closeModalProduto();
  await loadAll();
}));

// ---------- FORNECEDORES ----------

function renderFornecedores() {
  const tbody = $('#fornecedores-table-body');
  tbody.innerHTML = '';

  if (suppliers.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="muted">Nenhum fornecedor cadastrado.</td></tr>';
    return;
  }

  suppliers.forEach((s) => {
    tbody.innerHTML += `
      <tr>
        <td>${s.name}</td>
        <td>${s.contact || '—'}</td>
        <td>${s.notes || '—'}</td>
        <td><button class="icon-btn ver-historico-btn" data-id="${s.id}">Ver histórico</button></td>
      </tr>`;
  });

  $$('.ver-historico-btn').forEach((btn) => {
    btn.addEventListener('click', () => showHistoricoFornecedor(btn.dataset.id));
  });
}

function showHistoricoFornecedor(supplierId) {
  selectedSupplierId = supplierId;
  $('#historico-fornecedor-titulo').hidden = false;
  $('#historico-fornecedor-table').hidden = false;
  $('#historico-fornecedor-titulo').textContent = `HISTÓRICO DE COMPRAS · ${supplierName(supplierId)}`;

  const body = $('#historico-fornecedor-body');
  body.innerHTML = '';
  const entries = stockEntries.filter((e) => e.supplier_id === supplierId);

  if (entries.length === 0) {
    body.innerHTML = '<tr><td colspan="4" class="muted">Nenhuma compra registrada com este fornecedor.</td></tr>';
    return;
  }

  entries.forEach((e) => {
    body.innerHTML += `
      <tr>
        <td>${formatDate(e.entry_date)}</td>
        <td>${productName(e.product_id)}</td>
        <td>${formatQty(e.quantity)}</td>
        <td>${formatMoney(e.unit_cost)}</td>
      </tr>`;
  });
}

function openModalFornecedor() {
  $('#modal-fornecedor-nome').value = '';
  $('#modal-fornecedor-contato').value = '';
  $('#modal-fornecedor-obs').value = '';
  $('#modal-fornecedor-error').textContent = '';
  $('#modal-fornecedor-overlay').classList.add('open');
  $('#modal-fornecedor').classList.add('open');
}
function closeModalFornecedor() {
  $('#modal-fornecedor-overlay').classList.remove('open');
  $('#modal-fornecedor').classList.remove('open');
}

$('#btn-novo-fornecedor').addEventListener('click', openModalFornecedor);
$('#modal-fornecedor-cancel').addEventListener('click', closeModalFornecedor);
$('#modal-fornecedor-overlay').addEventListener('click', closeModalFornecedor);

$('#modal-fornecedor-confirm').addEventListener('click', guardAgainstDoubleSubmit($('#modal-fornecedor-confirm'), async () => {
  const name = $('#modal-fornecedor-nome').value.trim();
  const contact = $('#modal-fornecedor-contato').value.trim();
  const notes = $('#modal-fornecedor-obs').value.trim();

  if (!name) {
    $('#modal-fornecedor-error').textContent = 'Preencha o nome do fornecedor.';
    return;
  }

  const { error } = await db.from('suppliers').insert({ name, contact: contact || null, notes: notes || null });
  if (error) {
    $('#modal-fornecedor-error').textContent = 'Erro ao salvar: ' + error.message;
    return;
  }

  closeModalFornecedor();
  await loadAll();
}));

// ---------- ENTRADA DE ESTOQUE (COMPRA) ----------

$('#compra-data').value = todayISO();

function renderCompras() {
  const tbody = $('#compras-table-body');
  tbody.innerHTML = '';

  if (stockEntries.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="muted">Nenhuma entrada registrada.</td></tr>';
    return;
  }

  stockEntries.slice(0, 30).forEach((e) => {
    tbody.innerHTML += `
      <tr>
        <td>${formatDate(e.entry_date)}</td>
        <td>${productName(e.product_id)}</td>
        <td>${supplierName(e.supplier_id)}</td>
        <td>${formatQty(e.quantity)}</td>
        <td>${formatMoney(e.unit_cost)}</td>
      </tr>`;
  });
}

$('#form-compra').addEventListener('submit', guardAgainstDoubleSubmit($('#compra-submit'), async () => {
  $('#compra-error').textContent = '';

  const productId = $('#compra-produto').value;
  const supplierId = $('#compra-fornecedor').value;
  const quantity = parseFloat($('#compra-quantidade').value);
  const unitCost = parseFloat($('#compra-custo').value);
  const entryDate = $('#compra-data').value;

  if (!productId || !supplierId || !quantity || Number.isNaN(unitCost) || !entryDate) {
    $('#compra-error').textContent = 'Preencha todos os campos.';
    return;
  }

  const { error } = await db.rpc('register_stock_entry', {
    p_product_id: productId,
    p_supplier_id: supplierId,
    p_quantity: quantity,
    p_unit_cost: unitCost,
    p_entry_date: entryDate,
  });

  if (error) {
    $('#compra-error').textContent = error.message;
    return;
  }

  $('#form-compra').reset();
  $('#compra-data').value = todayISO();
  await loadAll();
}));

// ---------- VENDA (MINI-PDV) ----------

let cart = [];

function renderCarrinho() {
  const body = $('#venda-itens-body');
  body.innerHTML = '';

  if (cart.length === 0) {
    body.innerHTML = '<tr><td colspan="5" class="muted">Nenhum item adicionado.</td></tr>';
  } else {
    cart.forEach((item, index) => {
      const product = products.find((p) => p.id === item.productId);
      const subtotal = item.quantity * Number(product?.sale_price || 0);
      body.innerHTML += `
        <tr>
          <td>${product?.name || '—'}</td>
          <td>${formatQty(item.quantity)}</td>
          <td>${formatMoney(product?.sale_price)}</td>
          <td>${formatMoney(subtotal)}</td>
          <td><button class="icon-btn remove-item-btn" data-index="${index}">Remover</button></td>
        </tr>`;
    });
  }

  const total = cart.reduce((sum, item) => {
    const product = products.find((p) => p.id === item.productId);
    return sum + item.quantity * Number(product?.sale_price || 0);
  }, 0);
  $('#venda-total').textContent = formatMoney(total);

  $$('.remove-item-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      cart.splice(Number(btn.dataset.index), 1);
      renderCarrinho();
    });
  });
}

$('#btn-add-item-venda').addEventListener('click', () => {
  $('#venda-item-error').textContent = '';
  const productId = $('#venda-produto').value;
  const quantity = parseFloat($('#venda-quantidade').value);

  if (!productId || !quantity || quantity <= 0) {
    $('#venda-item-error').textContent = 'Selecione um produto e uma quantidade válida.';
    return;
  }

  const existing = cart.find((item) => item.productId === productId);
  if (existing) {
    existing.quantity += quantity;
  } else {
    cart.push({ productId, quantity });
  }

  $('#venda-quantidade').value = 1;
  renderCarrinho();
});

$('#btn-confirmar-venda').addEventListener('click', guardAgainstDoubleSubmit($('#btn-confirmar-venda'), async () => {
  $('#venda-error').textContent = '';

  if (cart.length === 0) {
    $('#venda-error').textContent = 'Adicione ao menos um item à venda.';
    return;
  }

  const seller = $('#venda-vendedor').value.trim() || null;
  const items = cart.map((item) => ({ product_id: item.productId, quantity: item.quantity }));

  const { error } = await db.rpc('register_sale', { p_seller: seller, p_items: items });

  if (error) {
    $('#venda-error').textContent = error.message;
    return;
  }

  cart = [];
  $('#venda-vendedor').value = '';
  renderCarrinho();
  await loadAll();
}));

renderCarrinho();

// ---------- AJUSTE DE ESTOQUE ----------

function renderAjustes() {
  const tbody = $('#movimentacoes-table-body');
  tbody.innerHTML = '';

  if (stockMovements.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="muted">Nenhuma movimentação registrada.</td></tr>';
    return;
  }

  const labels = { purchase: 'Compra', sale: 'Venda', adjustment: 'Ajuste' };

  stockMovements.slice(0, 50).forEach((m) => {
    tbody.innerHTML += `
      <tr>
        <td>${formatDate(m.created_at)}</td>
        <td>${productName(m.product_id)}</td>
        <td>${labels[m.type] || m.type}</td>
        <td>${Number(m.quantity) > 0 ? '+' : ''}${formatQty(m.quantity)}</td>
        <td>${m.reason || '—'}</td>
      </tr>`;
  });
}

$('#form-ajuste').addEventListener('submit', guardAgainstDoubleSubmit($('#ajuste-submit'), async () => {
  $('#ajuste-error').textContent = '';

  const productId = $('#ajuste-produto').value;
  const quantity = parseFloat($('#ajuste-quantidade').value);
  const reason = $('#ajuste-motivo').value.trim();

  if (!productId || !quantity || !reason) {
    $('#ajuste-error').textContent = 'Preencha produto, quantidade e motivo.';
    return;
  }

  const { error } = await db.rpc('adjust_stock', {
    p_product_id: productId,
    p_quantity: quantity,
    p_reason: reason,
  });

  if (error) {
    $('#ajuste-error').textContent = error.message;
    return;
  }

  $('#form-ajuste').reset();
  await loadAll();
}));

// ---------- RELATÓRIOS ----------

function renderRelatorios() {
  const estoqueBody = $('#relatorio-estoque-body');
  estoqueBody.innerHTML = '';
  const ativos = products.filter((p) => p.active);

  if (ativos.length === 0) {
    estoqueBody.innerHTML = '<tr><td colspan="4" class="muted">Nenhum produto ativo.</td></tr>';
  } else {
    ativos.forEach((p) => {
      const valorTotal = Number(p.current_stock) * Number(p.avg_cost);
      estoqueBody.innerHTML += `
        <tr>
          <td>${p.name}</td>
          <td>${formatQty(p.current_stock)} ${p.unit}</td>
          <td>${formatMoney(p.avg_cost)}</td>
          <td>${formatMoney(valorTotal)}</td>
        </tr>`;
    });
  }

  const margemBody = $('#relatorio-margem-body');
  margemBody.innerHTML = '';
  const porProduto = {};
  saleItems.forEach((it) => {
    if (!porProduto[it.product_id]) porProduto[it.product_id] = { qty: 0, receita: 0, custo: 0 };
    porProduto[it.product_id].qty += Number(it.quantity);
    porProduto[it.product_id].receita += Number(it.quantity) * Number(it.unit_price);
    porProduto[it.product_id].custo += Number(it.quantity) * Number(it.unit_cost_at_sale);
  });

  const linhas = Object.entries(porProduto).sort((a, b) => b[1].receita - a[1].receita);

  if (linhas.length === 0) {
    margemBody.innerHTML = '<tr><td colspan="5" class="muted">Nenhuma venda registrada ainda.</td></tr>';
  } else {
    linhas.forEach(([productId, agg]) => {
      const margem = agg.receita - agg.custo;
      margemBody.innerHTML += `
        <tr>
          <td>${productName(productId)}</td>
          <td>${formatQty(agg.qty)}</td>
          <td>${formatMoney(agg.receita)}</td>
          <td>${formatMoney(agg.custo)}</td>
          <td>${formatMoney(margem)}</td>
        </tr>`;
    });
  }
}

// ---------- INIT ----------

checkSession();
