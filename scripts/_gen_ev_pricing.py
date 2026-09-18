"""Generate deploy/ev-pricing.js data block straight from the Eastview workbook JSON."""
import json, io

d = json.load(open('/tmp/ev_tables.json'))
q = json.dumps

FICO_KEYS = {
    'FICO: 780+': 'f780', 'FICO: 760 - 779': 'f760', 'FICO: 740 - 759': 'f740',
    'FICO: 720 - 739': 'f720', 'FICO: 700 - 719': 'f700', 'FICO: 680 - 699': 'f680',
    'FICO: 660 - 679': 'f660', 'FICO: 640 - 659': 'f640', 'FICO: 620 - 639': 'f620',
    'Foreign National': 'fn',
}
ADJ_KEYS = {
    '0.80 <= DSCR < 1.00': 'dscr80', '1.00 <= DSCR < 1.10': 'dscr100', 'DSCR >=1.15': 'dscr115',
    'UPB <= $150,000': 'upbSmall', ' $2,000,000 < UPB <= $3,000,000': 'upbLarge',
    'Refinance (Cash Out)': 'cashOut', 'Non-Warrantable Condo': 'nonWarrantable', 'Condo': 'condo',
    '2-4 Unit': 'unit24', '7 Years (84 Months) Minimum Interest': 'pp7min',
    '7 Years (7%/6%/5%/4%/3%/2%/1%)': 'pp7', '5 Years (60 Months) Minimum Interest': 'pp5min',
    '5 Years (5%/4%/3%/2%/1%)': 'pp5', '3 Years (3%/2%/1%)': 'pp3', '2 Years (2%/1%)': 'pp2',
    '1 Year (1%)': 'pp1', 'No Prepayment Penalty': 'ppNone', 'Interest Only (10 Years)': 'io',
    '5-9 Unit': 'unit59', 'Cross-Collateralized Portfolio': 'crossColl',
}
PREPAY_LABELS = {
    'pp7min': '7 Years (84 Months) Minimum Interest', 'pp7': '7 Years (7%/6%/5%/4%/3%/2%/1%)',
    'pp5min': '5 Years (60 Months) Minimum Interest', 'pp5': '5 Years (5%/4%/3%/2%/1%)',
    'pp3': '3 Years (3%/2%/1%)', 'pp2': '2 Years (2%/1%)', 'pp1': '1 Year (1%)',
    'ppNone': 'No Prepayment Penalty',
}
MAXPRICE = {}
for label, v in d['maxPrice'].items():
    name = label.replace('Max Price - Prepayment Penalty: ', '')
    for k, l in PREPAY_LABELS.items():
        if l == name:
            MAXPRICE[k] = v
PURPOSE = {'Purchase': 'purchase', 'Refinance (No Cash Out)': 'refi_rt', 'Refinance (Cash Out)': 'refi_co'}
lev = {}
for row in d['lev']:
    lev.setdefault(FICO_KEYS[row['fico']], {})[PURPOSE[row['purpose']]] = {
        'ltv': row['ltv'] if row['ltv'] != 'N/A' else None,
        'ltc': row['ltc'] if row['ltc'] != 'N/A' else None,
    }
state_prepay = {k: v for k, v in d['statePrepay'].items() if v and v != '--'}

lines = []
A = lines.append
A('  // Coupon -> price, exactly as Eastview publishes it (Silver tier, 9/16/26).')
A('  couponPrices: [')
for c in d['coupons']:
    A('    { rate: %s, spread5yr: %s, fixed30: %s, arm51: %s, arm71: %s },'
      % (c['rate'], c['spread5yr'], repr(c['fixed30']), repr(c['arm51']), repr(c['arm71'])))
A('  ],')
A('  // LLPA columns, by LTV band: <=50, <=55, <=60, <=65, <=70, <=75, <=80.')
A('  ltvBands: %s,' % q(d['ltvBands']))
A('  ficoLlpa: {')
for label, key in FICO_KEYS.items():
    A('    %s: %s, // %s' % (key, q(d['fico'][label]), label))
A('  },')
A('  adj: {')
for label, key in ADJ_KEYS.items():
    A('    %s: %s, // %s' % (key, q(d['adj'][label]), label.strip()))
A('  },')
A('  maxPriceByPrepay: %s,' % q(MAXPRICE))
A('  prepayLabels: %s,' % q(PREPAY_LABELS))
A('  prepayMonths: %s,' % q({k: d['prepayMonths'][l] for k, l in PREPAY_LABELS.items() if l in d['prepayMonths']}))
A('  levGrid: %s,' % q(lev))
A('  statePrepayLimits: %s,' % q(state_prepay))
io.open('/tmp/ev_data.js', 'w', encoding='utf-8', newline='').write('\n'.join(lines) + '\n')
print('\n'.join(lines[:6]))
print('... %d lines' % len(lines))
