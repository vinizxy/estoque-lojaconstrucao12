# Gestão de Estoque e Custos — Loja de Construção

Data: 2026-09-12
Status: aprovado para plano de implementação
Cliente: real (loja de material de construção)

## Contexto e objetivo

O cliente já usa (via Hangar) um CRM de teste feito em HTML/CSS/JS puro + Supabase +
Cloudflare Pages (`crm-teste-barbearia`). Este projeto é novo e separado: um sistema
de gestão de estoque e custos de material para uma loja de construção, com baixa
automática de estoque na venda como automação central.

Diferente do CRM de teste, este é um cliente real — dados reais desde o início, então
autenticação e RLS não podem ser abertos como no projeto de teste.

## Usuários e acesso

- Papéis previstos: dono, estoquista, vendedor — mas na v1 todos os usuários
  autenticados têm o mesmo nível de acesso (sem restrição de tela por papel).
- Autenticação via Supabase Auth (email/senha).
- RLS restrito a "usuário autenticado" (não políticas abertas).
- Diferenciação de acesso por papel fica para uma versão futura.

## Stack

- Frontend: HTML/CSS/JS puro, sem build (mesmo padrão do CRM).
- Banco: Supabase (Postgres).
- Hospedagem: Cloudflare Pages.

## Modelo de dados

### `products`
- nome, categoria, unidade de medida (saco, m², barra, kg, un, metro, configurável
  por produto), estoque atual, estoque mínimo, custo médio atual (calculado),
  preço de venda (editável), ativo (bool, soft delete).

### `suppliers`
- nome, contato, observações.

### `stock_entries` (compras/entradas)
- produto, fornecedor, quantidade, custo unitário pago, data.
- Cada entrada: soma ao estoque do produto e recalcula o custo médio ponderado.

### `sales` / `sale_items` (vendas)
- `sales`: data, vendedor, total.
- `sale_items`: venda, produto, quantidade, preço unitário no momento da venda.
- Ao confirmar a venda, dá baixa automática em `products.estoque_atual`.

### `stock_movements` (auditoria)
- Log de toda entrada/saída: compra, venda, ajuste manual, perda.
- Nada é deletado do histórico; correções viram novos registros.

## Telas e fluxos

- **Dashboard**: valor total em estoque (Σ quantidade × custo médio), produtos
  abaixo do estoque mínimo, vendas do dia/mês, produtos mais vendidos.
- **Produtos**: CRUD de materiais (nome, categoria, unidade, estoque mínimo, custo
  médio somente leitura, preço de venda editável com sugestão baseada em custo +
  margem). Exclusão é soft delete (campo `ativo`) se houver movimentações.
- **Fornecedores**: CRUD simples + histórico de compras por fornecedor.
- **Entrada de estoque (compra)**: fornecedor, produto, quantidade, custo unitário,
  data. Atualiza estoque e custo médio; grava em `stock_movements`.
- **Venda (mini-PDV)**: seleção de produtos e quantidades, cálculo de subtotal/total
  pelo preço de venda atual. Bloqueia confirmação se a quantidade pedida for maior
  que o estoque disponível. Dá baixa automática no estoque ao confirmar.
- **Ajuste manual de estoque**: produto, quantidade (+/-), motivo (perda, quebra,
  contagem de inventário). Não afeta custo médio. Registrado em `stock_movements`.
- **Relatórios**: estoque valorizado atual, movimentações por período, vendas por
  produto/período, margem realizada.
- **Alertas de estoque baixo**: lista no dashboard dos produtos com estoque abaixo
  do mínimo cadastrado (sem notificação externa por email/whatsapp na v1).

Fora de escopo na v1: cancelamento/estorno de venda confirmada (correções via
ajuste manual), notificações externas de estoque baixo, controle de acesso por
papel, múltiplas lojas/filiais.

## Regras de negócio

### Custo médio ponderado

Em toda entrada de compra:

```
novo_custo_medio = (estoque_atual × custo_medio_atual + qtd_entrada × custo_unitario_entrada)
                   / (estoque_atual + qtd_entrada)
```

Se o estoque atual for zero, o novo custo médio é o custo da entrada.

### Concorrência e integridade

A baixa de estoque na venda e o recálculo de custo médio na compra rodam como
**funções no Postgres (RPC do Supabase)**, com bloqueio de linha (`SELECT ... FOR
UPDATE`) dentro de uma transação. A validação "há estoque suficiente?" acontece
atomicamente no banco — não faz sentido ler o estoque no JavaScript, calcular no
cliente e gravar depois, porque duas vendas simultâneas do mesmo produto podem
gerar estoque negativo mesmo com a checagem de UI.

### Validações

- Quantidade sempre > 0 em qualquer lançamento (entrada, venda, ajuste positivo).
- Ajuste manual pode ser negativo (para registrar perda/quebra), mas não pode levar
  o estoque abaixo de zero.
- Custo unitário de entrada não pode ser negativo (zero é permitido, ex: doação).
- Venda é bloqueada (não apenas avisada) se a quantidade pedida exceder o estoque
  disponível no momento da confirmação.
- Produto não pode ser excluído fisicamente se tiver movimentações associadas —
  apenas inativado.

## Testes

Prioridade de testes automatizados na lógica crítica de negócio, antes das telas:

- Cálculo de custo médio ponderado (casos: estoque zero, múltiplas entradas
  sucessivas, custo zero).
- Bloqueio de venda sem estoque suficiente.
- Concorrência: duas chamadas simultâneas à função de baixa de estoque no mesmo
  produto não devem permitir estoque negativo (teste de corrida na função RPC).
- Ajuste manual não permite estoque negativo.
- Soft delete: produto com movimentações não pode ser excluído fisicamente.

## Erros e casos de borda cobertos

- Estoque insuficiente na venda → bloqueado com mensagem clara, venda não é
  gravada parcialmente.
- Duas operações concorrentes no mesmo produto → resolvidas atomicamente no banco.
- Exclusão de produto com histórico → impedida, sugerida inativação.
- Ajuste manual que zeraria/negativaria estoque → bloqueado.
