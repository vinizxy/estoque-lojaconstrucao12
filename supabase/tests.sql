-- Testes da lógica crítica de negócio (custo médio, bloqueio de venda sem
-- estoque, ajuste manual, proteções de trigger).
--
-- Rode este arquivo inteiro no SQL Editor do Supabase DEPOIS do schema.sql.
-- Tudo roda dentro de uma transação e termina em ROLLBACK: não deixa
-- nenhum dado de teste no banco, mesmo se tudo passar.
--
-- Se alguma asserção falhar, a mensagem de erro identifica qual teste
-- quebrou e a transação é automaticamente desfeita.

begin;

do $$
declare
  v_product_a  uuid;
  v_product_b  uuid;
  v_supplier   uuid;
  v_entry      stock_entries;
  v_product    products;
  v_sale_id    uuid;
  v_total      numeric;
  v_failed     boolean;
begin
  -- ---------- SETUP ----------
  insert into suppliers (name) values ('Fornecedor Teste') returning id into v_supplier;

  insert into products (name, unit, current_stock, avg_cost, sale_price, min_stock)
  values ('Cimento Teste 50kg', 'saco', 0, 0, 40.00, 5)
  returning id into v_product_a;

  insert into products (name, unit, current_stock, avg_cost, sale_price, min_stock)
  values ('Areia Teste m3', 'm3', 10, 50.00, 80.00, 2)
  returning id into v_product_b;

  -- ---------- TESTE 1: custo médio na primeira entrada (estoque zerado) ----------
  v_entry := register_stock_entry(v_product_a, v_supplier, 100, 25.00, current_date);
  select * into v_product from products where id = v_product_a;

  if v_product.avg_cost <> 25.00 or v_product.current_stock <> 100 then
    raise exception 'TESTE 1 FALHOU: esperado custo médio 25.00 e estoque 100, obtido custo % estoque %',
      v_product.avg_cost, v_product.current_stock;
  end if;
  raise notice 'TESTE 1 OK: custo médio na primeira entrada';

  -- ---------- TESTE 2: custo médio ponderado em entrada subsequente ----------
  -- estoque 100 a 25.00 + 50 a 40.00 => (100*25 + 50*40) / 150 = 30.00
  v_entry := register_stock_entry(v_product_a, v_supplier, 50, 40.00, current_date);
  select * into v_product from products where id = v_product_a;

  if v_product.avg_cost <> 30.00 or v_product.current_stock <> 150 then
    raise exception 'TESTE 2 FALHOU: esperado custo médio 30.00 e estoque 150, obtido custo % estoque %',
      v_product.avg_cost, v_product.current_stock;
  end if;
  raise notice 'TESTE 2 OK: custo médio ponderado em entrada subsequente';

  -- ---------- TESTE 3: venda com sucesso dá baixa e calcula total pelo preço de venda ----------
  select sale_id, total into v_sale_id, v_total
  from register_sale('Vendedor Teste', jsonb_build_array(
    jsonb_build_object('product_id', v_product_a, 'quantity', 10),
    jsonb_build_object('product_id', v_product_b, 'quantity', 2)
  ));

  select * into v_product from products where id = v_product_a;
  if v_product.current_stock <> 140 then
    raise exception 'TESTE 3 FALHOU: estoque do produto A deveria ser 140, obtido %', v_product.current_stock;
  end if;

  select * into v_product from products where id = v_product_b;
  if v_product.current_stock <> 8 then
    raise exception 'TESTE 3 FALHOU: estoque do produto B deveria ser 8, obtido %', v_product.current_stock;
  end if;

  if v_total <> (10 * 40.00 + 2 * 80.00) then
    raise exception 'TESTE 3 FALHOU: total esperado %, obtido %', (10 * 40.00 + 2 * 80.00), v_total;
  end if;
  raise notice 'TESTE 3 OK: venda com sucesso';

  -- ---------- TESTE 4: venda é bloqueada quando não há estoque suficiente ----------
  v_failed := false;
  begin
    perform register_sale('Vendedor Teste', jsonb_build_array(
      jsonb_build_object('product_id', v_product_b, 'quantity', 999)
    ));
  exception when others then
    v_failed := true;
  end;

  if not v_failed then
    raise exception 'TESTE 4 FALHOU: venda sem estoque suficiente deveria ter sido bloqueada';
  end if;

  select * into v_product from products where id = v_product_b;
  if v_product.current_stock <> 8 then
    raise exception 'TESTE 4 FALHOU: estoque do produto B não deveria ter mudado, obtido %', v_product.current_stock;
  end if;
  raise notice 'TESTE 4 OK: venda sem estoque suficiente é bloqueada e não altera nada';

  -- ---------- TESTE 5: ajuste manual não permite estoque negativo ----------
  v_failed := false;
  begin
    perform adjust_stock(v_product_b, -999, 'Contagem de inventário');
  exception when others then
    v_failed := true;
  end;

  if not v_failed then
    raise exception 'TESTE 5 FALHOU: ajuste que resultaria em estoque negativo deveria ser bloqueado';
  end if;
  raise notice 'TESTE 5 OK: ajuste que zeraria/negativaria estoque é bloqueado';

  -- ---------- TESTE 6: ajuste manual válido não mexe no custo médio ----------
  perform adjust_stock(v_product_a, -5, 'Quebra de material');
  select * into v_product from products where id = v_product_a;

  if v_product.current_stock <> 135 or v_product.avg_cost <> 30.00 then
    raise exception 'TESTE 6 FALHOU: esperado estoque 135 e custo médio 30.00, obtido estoque % custo %',
      v_product.current_stock, v_product.avg_cost;
  end if;
  raise notice 'TESTE 6 OK: ajuste manual altera estoque sem tocar no custo médio';

  -- ---------- TESTE 7: UPDATE direto de current_stock/avg_cost é bloqueado ----------
  v_failed := false;
  begin
    update products set current_stock = 99999 where id = v_product_a;
  exception when others then
    v_failed := true;
  end;

  if not v_failed then
    raise exception 'TESTE 7 FALHOU: UPDATE direto de current_stock deveria ser bloqueado pelo trigger';
  end if;
  raise notice 'TESTE 7 OK: trigger bloqueia alteração direta de current_stock/avg_cost';

  -- ---------- TESTE 8: produto com movimentações não pode ser excluído ----------
  v_failed := false;
  begin
    delete from products where id = v_product_a;
  exception when others then
    v_failed := true;
  end;

  if not v_failed then
    raise exception 'TESTE 8 FALHOU: exclusão de produto com histórico deveria ser bloqueada';
  end if;
  raise notice 'TESTE 8 OK: trigger bloqueia exclusão de produto com movimentações';

  raise notice '--- TODOS OS TESTES PASSARAM ---';
end $$;

rollback;

-- NOTA sobre teste de concorrência (duas vendas simultâneas do mesmo produto):
-- isso exige duas sessões/transações reais rodando ao mesmo tempo, o que não
-- dá pra simular em um único script SQL sequencial. Para validar manualmente:
-- abra duas abas do SQL Editor, comece uma transação em cada
-- (BEGIN; depois SELECT register_sale(...) sem COMMIT ainda), confirme que a
-- segunda aba fica bloqueada (esperando o "FOR UPDATE" da primeira) até a
-- primeira dar COMMIT ou ROLLBACK — isso comprova que o lock de linha está
-- funcionando e não deixa as duas venderem o mesmo estoque ao mesmo tempo.
