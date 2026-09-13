# Estoque & Custos — Loja de Construção

Sistema de gestão de estoque, custos de material e vendas para loja de material
de construção. Cliente real — dados reais desde o início.

- **Frontend**: HTML/CSS/JS puro, sem build
- **Banco**: Supabase (Postgres)
- **Hospedagem**: Cloudflare Pages

Design completo em [`docs/superpowers/specs/2026-09-12-estoque-loja-construcao-design.md`](docs/superpowers/specs/2026-09-12-estoque-loja-construcao-design.md).

## Configuração inicial

1. Crie um projeto novo no [Supabase](https://supabase.com).
2. Abra o **SQL Editor** do projeto e rode, nesta ordem:
   - `supabase/schema.sql` — cria tabelas, RLS, triggers e as funções de negócio.
   - `supabase/tests.sql` — roda os testes da lógica crítica (custo médio,
     bloqueio de venda sem estoque, ajuste, triggers de proteção). Termina em
     `ROLLBACK`, não deixa dado nenhum no banco. Se tudo passar, o log do SQL
     Editor mostra "TESTE 1 OK" até "TESTE 8 OK" e "TODOS OS TESTES PASSARAM".
3. Em **Authentication > Users**, crie os usuários que vão logar no sistema
   (dono, estoquista, vendedores) com email e senha. Na v1 todos têm o mesmo
   nível de acesso.
4. Em **Project Settings > API**, copie a **Project URL** e a chave
   **anon/public**, e cole em [`config.js`](config.js).

## Rodar localmente

```bash
npx serve .
```

Abra o endereço mostrado (ex: http://localhost:3000).

## Deploy no Cloudflare Pages

```bash
npx wrangler pages deploy .
```

## Estrutura

- `index.html` — telas: login, Dashboard, Produtos, Fornecedores, Entrada de
  estoque, Venda, Ajuste de estoque, Relatórios.
- `style.css` — identidade visual (laranja de segurança + grafite, Oswald/Inter).
- `config.js` — URL e chave pública (anon) do Supabase.
- `app.js` — lógica da aplicação, autenticação e chamadas ao Supabase.
- `supabase/schema.sql` — schema completo do banco.
- `supabase/tests.sql` — testes da lógica de negócio crítica.

## Regras de negócio importantes

- **Custo médio ponderado**: recalculado a cada entrada de compra
  (`register_stock_entry`), nunca editável manualmente.
- **Baixa automática na venda**: `register_sale` valida estoque de todos os
  itens antes de gravar qualquer coisa; se faltar estoque de um item, a venda
  inteira é bloqueada.
- **Concorrência**: a baixa de estoque roda dentro de uma função do Postgres
  com `SELECT ... FOR UPDATE`, travando a linha do produto durante a operação
  — duas vendas simultâneas do mesmo produto não conseguem gerar estoque
  negativo.
- **Sem exclusão física**: produtos com movimentações não podem ser
  excluídos, só inativados (campo `active`). Vendas e entradas nunca são
  apagadas — histórico completo para auditoria.
- **Fora de escopo na v1**: cancelamento/estorno de venda, notificações
  externas de estoque baixo, controle de acesso por papel, múltiplas lojas.
