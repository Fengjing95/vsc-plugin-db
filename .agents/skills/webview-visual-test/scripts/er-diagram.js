// ER 图页场景（M8-ER / D-22）：库级关系图——表节点（PK/FK 标识）+ FK 边（鸦爪/单端）+
// 分层布局 + 搜索/紧凑/缩放工具栏 + 状态行。图数据为静态 ErGraphResult（er.getGraph stub）。
window.__DBX_STUB__ = {
  delayMs: 40,
  bootstrap: {
    page: 'erDiagram',
    viewId: 'erDiagram:c1/myapp',
    params: { connId: 'c1', db: 'myapp', scope: JSON.stringify({ kind: 'all' }) },
  },
  handlers: {
    'er.getGraph': () => {
      const H = 30, R = 22, P = 8; // headerHeight / rowHeight / padBottom
      const h = (rows) => H + rows * R + P;
      const W = 232, GX = 96, GY = 28;
      const col = (name, pk) => ({ name, dataType: pk ? 'bigint' : 'varchar(64)', isPrimaryKey: !!pk });
      const tables = [
        { name: 'order_items', columns: [col('id', 1), col('order_id'), col('product_id'), col('qty')] },
        { name: 'products', columns: [col('id', 1), col('category_id'), col('name'), col('price')] },
        { name: 'invoices', columns: [col('id', 1), col('order_id'), col('total')] },
        { name: 'employees', columns: [col('id', 1), col('manager_id'), col('name')] },
        { name: 'audit_log', columns: [col('id', 1), col('message')] },
        { name: 'orders', columns: [col('id', 1), col('user_id'), col('amount'), col('created_at')] },
        { name: 'categories', columns: [col('id', 1), col('name'), col('remark')] },
        { name: 'users', comment: '用户表', columns: [col('id', 1), col('role_id'), col('name'), col('email'), col('created_at')] },
        { name: 'roles', columns: [col('id', 1), col('name')] },
      ];
      // 分层（父表在右）：L0 x=0 / L1 x=328 / L2 x=656 / L3 x=984；层内垂直居中于 654 高画布
      const nodes = [
        { table: 'order_items', x: 0, y: 0, width: W, height: h(4) },
        { table: 'products', x: 0, y: 154, width: W, height: h(4) },
        { table: 'invoices', x: 0, y: 308, width: W, height: h(3) },
        { table: 'employees', x: 0, y: 440, width: W, height: h(3) },
        { table: 'audit_log', x: 0, y: 572, width: W, height: h(2) },
        { table: 'orders', x: 328, y: 198, width: W, height: h(4) },
        { table: 'categories', x: 328, y: 352, width: W, height: h(3) },
        { table: 'users', x: 656, y: 253, width: W, height: h(5) },
        { table: 'roles', x: 984, y: 286, width: W, height: h(2) },
      ];
      const edges = [
        { name: 'fk_items_order', sourceTable: 'order_items', sourceColumns: ['order_id'], targetTable: 'orders', targetColumns: ['id'] },
        { name: 'fk_items_product', sourceTable: 'order_items', sourceColumns: ['product_id'], targetTable: 'products', targetColumns: ['id'] },
        { name: 'fk_invoice_order', sourceTable: 'invoices', sourceColumns: ['order_id'], targetTable: 'orders', targetColumns: ['id'] },
        { name: 'fk_emp_manager', sourceTable: 'employees', sourceColumns: ['manager_id'], targetTable: 'employees', targetColumns: ['id'] },
        { name: 'fk_order_user', sourceTable: 'orders', sourceColumns: ['user_id'], targetTable: 'users', targetColumns: ['id'] },
        { name: 'fk_product_category', sourceTable: 'products', sourceColumns: ['category_id'], targetTable: 'categories', targetColumns: ['id'] },
        { name: 'fk_user_role', sourceTable: 'users', sourceColumns: ['role_id'], targetTable: 'roles', targetColumns: ['id'] },
      ];
      return {
        tables,
        edges,
        layout: { nodes, width: 1216, height: 654, nodeWidth: W, headerHeight: H, rowHeight: R, padBottom: P, layerGapX: GX, nodeGapY: GY },
        tableCount: tables.length,
        hiddenEdges: 0,
      };
    },
    'er.openTable': () => ({}),
    'sys.copyText': (p) => ({ written: (p?.text ?? '').length }),
  },
};
