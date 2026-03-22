/**
 * Khedmah Platform — Prisma Seed
 * Run: npx prisma db seed
 *
 * NOTE: passwords here are bcrypt hashes of 'Demo@12345'
 * (12 rounds). Do NOT use these in production.
 */
import { PrismaClient, UserRole, EquipmentCategory, EquipmentStatus, ConsultationStatus, ConsultationMode } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

// Hash once at seed time so we don't hash repeatedly in loops
const DEMO_PASSWORD_HASH = bcrypt.hashSync('Demo@12345', 12);

async function main() {
  // ── Production guard ──────────────────────────────────────────────────────
  // Seed data is demo-only. Refuse to run against a production database to
  // prevent accidental pollution of live data.
  if (process.env.NODE_ENV === 'production') {
    console.error('❌  Seed refused: NODE_ENV=production. Never seed a production database.');
    process.exit(1);
  }

  console.log('🌱  Seeding Khedmah database...');

  // ── 1. Services catalog ──────────────────────────────────────────────────
  const serviceData = [
    { nameAr: 'تنظيف المنازل',        nameEn: 'House Cleaning',        category: 'cleaning',   icon: '🧹' },
    { nameAr: 'تركيب الكهرباء',       nameEn: 'Electrical',            category: 'electrical', icon: '⚡' },
    { nameAr: 'سباكة',                nameEn: 'Plumbing',              category: 'plumbing',   icon: '🔧' },
    { nameAr: 'تكييف وتبريد',         nameEn: 'HVAC',                  category: 'hvac',       icon: '❄️' },
    { nameAr: 'نقل الأثاث',           nameEn: 'Moving',                category: 'moving',     icon: '🚛' },
    { nameAr: 'مكافحة الحشرات',       nameEn: 'Pest Control',          category: 'pest',       icon: '🐛' },
    { nameAr: 'نجارة وأعمال خشبية',   nameEn: 'Carpentry',             category: 'carpentry',  icon: '🪚' },
    { nameAr: 'دهانات وديكور',        nameEn: 'Painting',              category: 'painting',   icon: '🎨' },
    { nameAr: 'تركيب الأقفال',        nameEn: 'Locksmith',             category: 'locksmith',  icon: '🔑' },
    { nameAr: 'غسيل السيارات',        nameEn: 'Car Wash',              category: 'car',        icon: '🚗' },
    { nameAr: 'بستنة وزراعة',         nameEn: 'Gardening',             category: 'garden',     icon: '🌿' },
    { nameAr: 'صيانة أجهزة منزلية',   nameEn: 'Appliance Repair',      category: 'appliance',  icon: '🔨' },
    { nameAr: 'خدمات التصوير',        nameEn: 'Photography',           category: 'media',      icon: '📷' },
    { nameAr: 'تركيب الإنترنت',       nameEn: 'IT Setup',              category: 'it',         icon: '🌐' },
    { nameAr: 'خدمات الطباخ المنزلي', nameEn: 'Home Chef',             category: 'catering',   icon: '👨‍🍳' },
    { nameAr: 'رعاية الأطفال',        nameEn: 'Childcare',             category: 'childcare',  icon: '👶' },
    { nameAr: 'رعاية المسنين',        nameEn: 'Elder Care',            category: 'eldercare',  icon: '👴' },
    { nameAr: 'تنظيف السجاد',         nameEn: 'Carpet Cleaning',       category: 'cleaning',   icon: '🧺' },
    { nameAr: 'تنظيف الخزانات',       nameEn: 'Tank Cleaning',         category: 'cleaning',   icon: '💧' },
    { nameAr: 'صيانة المسابح',        nameEn: 'Pool Maintenance',      category: 'pool',       icon: '🏊' },
    { nameAr: 'تركيب الستائر',        nameEn: 'Curtains Installation', category: 'interior',   icon: '🪟' },
    { nameAr: 'تركيب أنظمة الري',     nameEn: 'Irrigation Systems',    category: 'garden',     icon: '🌱' },
    { nameAr: 'حراسة أمنية',          nameEn: 'Security Guard',        category: 'security',   icon: '🔒' },
    { nameAr: 'صيانة السباكة',        nameEn: 'Plumbing Maintenance',  category: 'plumbing',   icon: '🪠' },
  ];

  const services: any[] = [];
  for (const s of serviceData) {
    const svc = await prisma.service.upsert({
      where:  { id: s.nameEn.toLowerCase().replace(/\s+/g, '_') },
      update: {},
      create: {
        id:       s.nameEn.toLowerCase().replace(/\s+/g, '_'),
        nameAr:   s.nameAr,
        nameEn:   s.nameEn,
        icon:     s.icon,
        active:   true,
        category: { connectOrCreate: {
          where:  { id: s.category },
          create: { id: s.category, nameAr: s.nameAr, nameEn: s.category, icon: s.icon },
        }},
      },
    });
    services.push(svc);
  }
  console.log(`  ✓ ${services.length} services seeded`);

  // ── 2. Super-admin user ──────────────────────────────────────────────────
  const adminUser = await prisma.user.upsert({
    where:  { email: 'admin@khedmah.sa' },
    update: {},
    create: {
      email:          'admin@khedmah.sa',
      username:       'admin_khedmah',
      passwordHash:   DEMO_PASSWORD_HASH,
      emailVerified:  true,
      emailVerifiedAt: new Date(),
      role:           UserRole.SUPER_ADMIN,
      status:         'ACTIVE',
      suspended:      false,
      profile: {
        create: { nameAr: 'مشرف النظام', nameEn: 'System Admin', city: 'الرياض' },
      },
    },
  });
  console.log(`  ✓ Admin: ${adminUser.email}`);

  // ── 3. Demo customer ─────────────────────────────────────────────────────
  const customer = await prisma.user.upsert({
    where:  { email: 'customer@demo.sa' },
    update: {},
    create: {
      email:           'customer@demo.sa',
      username:        'ahmed_customer',
      passwordHash:    DEMO_PASSWORD_HASH,
      emailVerified:   true,
      emailVerifiedAt: new Date(),
      role:            UserRole.CUSTOMER,
      status:          'ACTIVE',
      profile: {
        create: { nameAr: 'أحمد الراشد', nameEn: 'Ahmed Al-Rashed', city: 'الرياض' },
      },
    },
  });
  console.log(`  ✓ Customer: ${customer.email}`);

  // ── 4. Demo providers ────────────────────────────────────────────────────
  const providerData = [
    { email: 'khalid@demo.sa', username: 'khalid_elec',    nameAr: 'خالد العتيبي', nameEn: 'Khalid Al-Otaibi', phone: '+966522222222', city: 'الرياض', jobs: 87  },
    { email: 'salem@demo.sa',  username: 'salem_plumber',  nameAr: 'سالم الغامدي', nameEn: 'Salem Al-Ghamdi',  phone: '+966533333333', city: 'جدة',    jobs: 54  },
    { email: 'fahad@demo.sa',  username: 'fahad_clean',    nameAr: 'فهد الحربي',   nameEn: 'Fahad Al-Harbi',   phone: '+966544444444', city: 'الدمام', jobs: 112 },
  ];

  for (const p of providerData) {
    const user = await prisma.user.upsert({
      where:  { email: p.email },
      update: {},
      create: {
        email:           p.email,
        username:        p.username,
        passwordHash:    DEMO_PASSWORD_HASH,
        phone:           p.phone,
        emailVerified:   true,
        emailVerifiedAt: new Date(),
        role:            UserRole.PROVIDER,
        status:          'ACTIVE',
        profile: {
          create: { nameAr: p.nameAr, nameEn: p.nameEn, city: p.city },
        },
      },
    });

    await prisma.providerProfile.upsert({
      where:  { userId: user.id },
      update: {},
      create: {
        userId:             user.id,
        verificationStatus: 'APPROVED',
        verified:           true,
        idVerified:         true,
        approvedAt:         new Date(),
        ratingAvg:          Number((4.3 + Math.random() * 0.7).toFixed(2)),
        completedJobs:      p.jobs,
      },
    });
  }
  console.log(`  ✓ ${providerData.length} providers seeded`);

  // ── 5. Demo company + tender ─────────────────────────────────────────────
  const company = await prisma.company.upsert({
    where:  { crNumber: '1000000001' },
    update: {},
    create: {
      ownerId:  adminUser.id,
      nameAr:   'مجموعة البناء المتكامل',
      nameEn:   'Integrated Construction Group',
      crNumber: '1000000001',
      city:     'الرياض',
      region:   'الرياض',
      verified: true,
    },
  });

  const existingTender = await prisma.tender.findFirst({ where: { companyId: company.id } });
  if (!existingTender) {
    await prisma.tender.create({
      data: {
        companyId:   company.id,
        title:       'إنشاء مبنى سكني متعدد الطوابق — حي الملقا',
        category:    'إنشاء',
        description: 'مشروع تطوير سكني يشمل 3 أبراج سكنية بمجموع 120 وحدة سكنية مع مرافق مشتركة',
        region:      'الرياض',
        budgetMin:   12_000_000,
        budgetMax:   15_000_000,
        deadline:    new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        status:      'OPEN',
      },
    });
  }
  console.log(`  ✓ Company + tender seeded`);

  // ── 6. Demo equipment ────────────────────────────────────────────────────
  const equipmentItems = [
    { name: 'حفار كاتربيلار 320',    category: EquipmentCategory.EXCAVATOR, brand: 'Caterpillar', region: 'الرياض', city: 'الرياض', dayPrice: 2500 },
    { name: 'رافعة ليبهير LTM1100',  category: EquipmentCategory.CRANE,     brand: 'Liebherr',    region: 'جدة',    city: 'جدة',    dayPrice: 5000 },
    { name: 'خلاطة خرسانة 9م³',      category: EquipmentCategory.MIXER,     brand: 'Putzmeister', region: 'الدمام', city: 'الدمام', dayPrice: 1200 },
  ];

  for (const eq of equipmentItems) {
    const existing = await prisma.equipment.findFirst({ where: { name: eq.name } });
    if (!existing) {
      await prisma.equipment.create({
        data: {
          ownerId:     adminUser.id,
          name:        eq.name,
          category:    eq.category,
          brand:       eq.brand,
          region:      eq.region,
          city:        eq.city,
          dayPrice:    eq.dayPrice,
          status:      EquipmentStatus.ACTIVE,
          isAvailable: true,
        },
      });
    }
  }
  console.log(`  ✓ ${equipmentItems.length} equipment listings seeded`);

  // ── 7. Demo consultations ─────────────────────────────────────────────────
  const consultService = await prisma.service.findFirst({ where: { nameEn: { contains: 'Electrical' } } });
  const khalidProvider = await prisma.user.findUnique({ where: { email: 'khalid@demo.sa' } });

  if (consultService && khalidProvider && customer) {
    const existingConsult = await prisma.consultation.findFirst({
      where: { customerId: customer.id },
    });

    if (!existingConsult) {
      // Completed consultation — shows in history
      await prisma.consultation.create({
        data: {
          customerId:      customer.id,
          providerId:      khalidProvider.id,
          serviceId:       consultService.id,
          status:          ConsultationStatus.COMPLETED,
          mode:            ConsultationMode.CHAT,
          topic:           'مراجعة لوحة التوزيع الكهربائية للمنزل',
          description:     'أحتاج مراجعة لوحة الكهرباء قبل إضافة معدات جديدة',
          durationMinutes: 45,
          pricePerHour:    200,
          totalAmount:     150,
          scheduledAt:     new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
          startedAt:       new Date(Date.now() - 7 * 24 * 60 * 60 * 1000 + 5 * 60 * 1000),
          completedAt:     new Date(Date.now() - 7 * 24 * 60 * 60 * 1000 + 50 * 60 * 1000),
          rating:          5,
          notes:           'اللوحة بحاجة لتحديث الفيوزات. نصحت بإضافة قاطع تفاضلي.',
        },
      });

      // Pending consultation — shows as active
      await prisma.consultation.create({
        data: {
          customerId:  customer.id,
          serviceId:   consultService.id,
          status:      ConsultationStatus.PENDING,
          mode:        ConsultationMode.VIDEO,
          topic:       'تصميم شبكة كهربائية لإضافة غرفة جديدة',
          description: 'أريد إضافة غرفة للمنزل وأحتاج خطة الكهرباء',
          scheduledAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
        },
      });
    }
  }
  console.log('  ✓ Demo consultations seeded');

  console.log('\n✅  Seed complete! Demo credentials: any @demo.sa email / Demo@12345');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
