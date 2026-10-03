import { describe, expect, it } from 'vitest';
import type { ColumnMeta } from '@db-explorer/core';
import { generateCode } from './codegen';

/** 列元数据便捷构造（ordinal 按传入顺序） */
function col(name: string, overrides: Partial<ColumnMeta> = {}): ColumnMeta {
  return {
    name,
    dataType: 'varchar(64)',
    normalizedType: 'string',
    nullable: true,
    isPrimaryKey: false,
    ordinal: 0,
    ...overrides,
  };
}

const users: ColumnMeta[] = [
  col('id', { dataType: 'bigint', normalizedType: 'integer', isPrimaryKey: true, autoIncrement: true, nullable: false, comment: '主键' }),
  col('user_name', { comment: '用户名' }),
  col('amount', { dataType: 'decimal(10,2)', normalizedType: 'decimal', nullable: false }),
  col('created_at', { dataType: 'datetime', normalizedType: 'datetime' }),
];

describe('generateCode: TypeScript interface', () => {
  it('DECIMAL=string（C-7）、PK 注释、camelCase 字段', () => {
    const code = generateCode('ts', 'user_order', users);
    expect(code).toContain('interface UserOrder {');
    expect(code).toContain('id: number;');
    expect(code).toContain('amount: string;');
    expect(code).toContain('userName: string;');
    expect(code).toContain('createdAt: string;');
    expect(code).toContain('/** bigint · 主键 */');
  });
});

describe('generateCode: Java POJO', () => {
  it('类型映射 + getter/setter 成对', () => {
    const code = generateCode('java', 'user_order', users);
    expect(code).toContain('public class UserOrder {');
    expect(code).toContain('private Long id;');
    expect(code).toContain('private BigDecimal amount;');
    expect(code).toContain('private LocalDateTime createdAt;');
    expect(code).toContain('public Long getId() { return id; }');
    expect(code).toContain('public void setAmount(BigDecimal amount) { this.amount = amount; }');
  });
});

describe('generateCode: Go struct', () => {
  it('json tag 用原列名、可空指针、DECIMAL=string', () => {
    const code = generateCode('go', 'user_order', users);
    expect(code).toContain('type UserOrder struct {');
    expect(code).toContain('ID int64 `json:"id"`');
    expect(code).toContain('Amount string `json:"amount"`');
    expect(code).toContain('CreatedAt *time.Time `json:"created_at,omitempty"`');
    expect(code).toContain('UserName *string `json:"user_name,omitempty"`');  });
});

describe('generateCode: Prisma schema', () => {
  it('PK + autoincrement → @id @default(autoincrement())，@map 保留原列名', () => {
    const code = generateCode('prisma', 'user_order', users);
    expect(code).toContain('model UserOrder {');
    // bigint 列 → BigInt（dataType 感知）
    expect(code).toContain('id BigInt @id @default(autoincrement()) @map("id")');
    expect(code).toContain('amount Decimal @map("amount")');
    expect(code).toContain('createdAt DateTime? @map("created_at")');
  });
});
