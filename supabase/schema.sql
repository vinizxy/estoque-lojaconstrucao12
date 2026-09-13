-- Gestão de Estoque e Custos — Loja de Construção
-- Schema completo: tabelas, RLS, triggers de proteção e funções RPC
-- Rode este arquivo inteiro no SQL Editor do Supabase (projeto novo, vazio).

create extension if not exists pgcrypto;

-- =========================================================================
-- TABELAS
-- =========================================================================

create table products (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  category      text,
  unit          text not null,                 -- ex: saco, m2, barra, kg, un, metro
  current_stock numeric not null default 0 check (current_stock >= 0),
  min_stock     numeric not null default 0 check (min_stock >= 0),
  avg_cost      numeric not null default 0 check (avg_cost >= 0),
  sale_price    numeric not null default 0 check (sale_price >= 0),
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

create table suppliers (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  contact    text,
  notes      text,
  created_at timestamptz not null default now()
);

create table stock_entries (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references products(id) on delete restrict,
  supplier_id uuid references suppliers(id) on delete restrict,
  quantity    numeric not null check (quantity > 0),
  unit_cost   numeric not null check (unit_cost >= 0),
  entry_date  date not null default current_date,
  created_at  timestamptz not null default now()
);

create table sales (
  id      uuid primary key default gen_random_uuid(),
  sold_at timestamptz not null default now(),
  seller  text,
  total   numeric not null default 0 check (total >= 0)
);

create table sale_items (
  id                  uuid primary key default gen_random_uuid(),
  sale_id             uuid not null references sales(id) on delete cascade,
  product_id          uuid not null references products(id) on delete restrict,
  quantity            numeric not null check (quantity > 0),
  unit_price          numeric not null check (unit_price >= 0),
  unit_cost_at_sale   numeric not null check (unit_cost_at_sale >= 0) -- custo médio do produto no momento da venda, para relatório de margem
);

create table stock_movements (
  id           uuid primary key default gen_random_uuid(),
  product_id   uuid not null references products(id) on delete restrict,
  type         text not null check (type in ('purchase', 'sale', 'adjustment')),
  quantity     numeric not null,      -- positivo = entrada, negativo = saída
  reason       text,                  -- usado em ajustes manuais
  reference_id uuid,                  -- id da stock_entry ou da sale que originou o movimento
  created_at   timestamptz not null default now()
);

create index idx_stock_entries_product on stock_entries(product_id);
create index idx_sale_items_sale on sale_items(sale_id);
create index idx_sale_items_product on sale_items(product_id);
create index idx_stock_movements_product on stock_movements(product_id);

-- =========================================================================
-- PROTEÇÕES A NÍVEL DE BANCO
-- =========================================================================

-- current_stock e avg_cost só podem mudar através das funções RPC abaixo,
-- nunca por um UPDATE direto vindo do cliente (evita divergência de dados).
create or replace function products_protect_stock_fields()
returns trigger
language plpgsql
as $$
begin
  if current_setting('app.allow_stock_write', true) is distinct from 'on' then
    if new.current_stock is distinct from old.current_stock
       or new.avg_cost is distinct from old.avg_cost then
      raise exception 'current_stock e avg_cost só podem ser alterados pelas rotinas de compra, venda ou ajuste de estoque';
    end if;
  end if;
  return new;
end;
$$;

create trigger trg_products_protect_stock
before update on products
for each row execute function products_protect_stock_fields();

-- Um produto com histórico de movimentação nunca pode ser excluído fisicamente
-- (só inativado via campo "active"), para não corromper relatórios e auditoria.
create or replace function products_block_delete_with_history()
returns trigger
language plpgsql
as $$
begin
  if exists (select 1 from stock_movements where product_id = old.id) then
    raise exception 'Não é possível excluir um produto com movimentações registradas; use "inativar" em vez de excluir.';
  end if;
  return old;
end;
$$;

create trigger trg_products_block_delete
before delete on products
for each row execute function products_block_delete_with_history();

-- =========================================================================
-- ROW LEVEL SECURITY
-- =========================================================================

alter table products enable row level security;
alter table suppliers enable row level security;
alter table stock_entries enable row level security;
alter table sales enable row level security;
alter table sale_items enable row level security;
alter table stock_movements enable row level security;

-- Leitura liberada para qualquer usuário autenticado em todas as tabelas.
create policy "read products" on products for select using (auth.role() = 'authenticated');
create policy "read suppliers" on suppliers for select using (auth.role() = 'authenticated');
create policy "read stock_entries" on stock_entries for select using (auth.role() = 'authenticated');
create policy "read sales" on sales for select using (auth.role() = 'authenticated');
create policy "read sale_items" on sale_items for select using (auth.role() = 'authenticated');
create policy "read stock_movements" on stock_movements for select using (auth.role() = 'authenticated');

-- Cadastro direto: só produtos e fornecedores (dados de cadastro, sem risco de
-- concorrência). Sem política de DELETE em nenhuma tabela — exclusão física
-- fica bloqueada por padrão; o app usa "active = false" para inativar.
create policy "insert products" on products for insert with check (auth.role() = 'authenticated');
create policy "update products" on products for update using (auth.role() = 'authenticated');
create policy "insert suppliers" on suppliers for insert with check (auth.role() = 'authenticated');
create policy "update suppliers" on suppliers for update using (auth.role() = 'authenticated');

-- stock_entries, sales, sale_items e stock_movements NÃO têm política de
-- insert/update para o cliente: só podem ser escritas pelas funções RPC
-- abaixo (SECURITY DEFINER, rodam como dono da tabela e ignoram RLS).

revoke all on products, suppliers, stock_entries, sales, sale_items, stock_movements from anon;
revoke all on products, suppliers, stock_entries, sales, sale_items, stock_movements from authenticated;

grant select on products, suppliers, stock_entries, sales, sale_items, stock_movements to authenticated;
grant insert, update on products to authenticated;
grant insert, update on suppliers to authenticated;

-- =========================================================================
-- FUNÇÕES RPC (regras de negócio críticas)
-- =========================================================================

-- Registra uma compra: soma ao estoque e recalcula o custo médio ponderado.
create or replace function register_stock_entry(
  p_product_id  uuid,
  p_supplier_id uuid,
  p_quantity    numeric,
  p_unit_cost   numeric,
  p_entry_date  date default current_date
)
returns stock_entries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product      record;
  v_new_avg_cost numeric;
  v_entry        stock_entries;
begin
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Quantidade da entrada deve ser maior que zero';
  end if;
  if p_unit_cost is null or p_unit_cost < 0 then
    raise exception 'Custo unitário não pode ser negativo';
  end if;

  select id, current_stock, avg_cost into v_product
  from products
  where id = p_product_id
  for update;

  if not found then
    raise exception 'Produto não encontrado';
  end if;

  if v_product.current_stock + p_quantity = 0 then
    v_new_avg_cost := 0;
  else
    v_new_avg_cost := (v_product.current_stock * v_product.avg_cost + p_quantity * p_unit_cost)
                      / (v_product.current_stock + p_quantity);
  end if;

  perform set_config('app.allow_stock_write', 'on', true);

  update products
  set current_stock = current_stock + p_quantity,
      avg_cost = v_new_avg_cost
  where id = p_product_id;

  perform set_config('app.allow_stock_write', 'off', true);

  insert into stock_entries (product_id, supplier_id, quantity, unit_cost, entry_date)
  values (p_product_id, p_supplier_id, p_quantity, p_unit_cost, p_entry_date)
  returning * into v_entry;

  insert into stock_movements (product_id, type, quantity, reference_id)
  values (p_product_id, 'purchase', p_quantity, v_entry.id);

  return v_entry;
end;
$$;

-- Registra uma venda com um ou mais itens. Bloqueia a venda inteira se
-- qualquer item não tiver estoque suficiente. Trava as linhas de produto em
-- ordem crescente de id para evitar deadlock entre vendas concorrentes que
-- compartilham produtos.
create or replace function register_sale(p_seller text, p_items jsonb)
returns table (sale_id uuid, total numeric)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale_id  uuid;
  v_total    numeric := 0;
  v_qty      numeric;
  v_product  record;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'A venda precisa ter pelo menos um item';
  end if;

  create temporary table _sale_items (
    product_id uuid primary key,
    quantity   numeric
  ) on commit drop;

  insert into _sale_items (product_id, quantity)
  select (elem->>'product_id')::uuid, sum((elem->>'quantity')::numeric)
  from jsonb_array_elements(p_items) as elem
  group by (elem->>'product_id')::uuid;

  if exists (select 1 from _sale_items where quantity is null or quantity <= 0) then
    raise exception 'Quantidade de item de venda deve ser maior que zero';
  end if;

  -- Trava e valida estoque de todos os produtos antes de gravar qualquer coisa.
  for v_product in
    select p.id, p.name, p.current_stock, p.sale_price, p.avg_cost
    from products p
    join _sale_items si on si.product_id = p.id
    order by p.id
    for update
  loop
    select quantity into v_qty from _sale_items where product_id = v_product.id;

    if v_product.current_stock < v_qty then
      raise exception 'Estoque insuficiente para "%": disponível %, pedido %',
        v_product.name, v_product.current_stock, v_qty;
    end if;

    v_total := v_total + (v_qty * v_product.sale_price);
  end loop;

  insert into sales (seller, total) values (p_seller, v_total) returning id into v_sale_id;

  perform set_config('app.allow_stock_write', 'on', true);

  for v_product in
    select p.id, p.sale_price, p.avg_cost
    from products p
    join _sale_items si on si.product_id = p.id
  loop
    select quantity into v_qty from _sale_items where product_id = v_product.id;

    insert into sale_items (sale_id, product_id, quantity, unit_price, unit_cost_at_sale)
    values (v_sale_id, v_product.id, v_qty, v_product.sale_price, v_product.avg_cost);

    update products
    set current_stock = current_stock - v_qty
    where id = v_product.id;

    insert into stock_movements (product_id, type, quantity, reference_id)
    values (v_product.id, 'sale', -v_qty, v_sale_id);
  end loop;

  perform set_config('app.allow_stock_write', 'off', true);

  return query select v_sale_id, v_total;
end;
$$;

-- Ajuste manual de estoque (perda, quebra, contagem de inventário). Nunca
-- mexe no custo médio. Não permite deixar o estoque negativo.
create or replace function adjust_stock(p_product_id uuid, p_quantity numeric, p_reason text)
returns products
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product record;
  v_result  products;
begin
  if p_quantity is null or p_quantity = 0 then
    raise exception 'Quantidade do ajuste não pode ser zero';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'Informe o motivo do ajuste';
  end if;

  select id, current_stock into v_product
  from products
  where id = p_product_id
  for update;

  if not found then
    raise exception 'Produto não encontrado';
  end if;

  if v_product.current_stock + p_quantity < 0 then
    raise exception 'Ajuste deixaria o estoque negativo (atual: %, ajuste: %)',
      v_product.current_stock, p_quantity;
  end if;

  perform set_config('app.allow_stock_write', 'on', true);

  update products
  set current_stock = current_stock + p_quantity
  where id = p_product_id
  returning * into v_result;

  perform set_config('app.allow_stock_write', 'off', true);

  insert into stock_movements (product_id, type, quantity, reason)
  values (p_product_id, 'adjustment', p_quantity, p_reason);

  return v_result;
end;
$$;

grant execute on function register_stock_entry(uuid, uuid, numeric, numeric, date) to authenticated;
grant execute on function register_sale(text, jsonb) to authenticated;
grant execute on function adjust_stock(uuid, numeric, text) to authenticated;
