import {
  ButtonInteraction,
  EmbedBuilder,
  GuildMember,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ModalSubmitInteraction,
  TextChannel,
  ButtonBuilder,
  ButtonStyle,
  ThreadChannel,
} from "discord.js";
import { randomUUID } from "crypto";
import {
  getWhitelistUser,
  getUserKeys,
  getByKey,
  setVipRoleAssigned,
  getLastHwidReset,
  logHwidReset,
  resetHwidAndIncrementCount,
  addToWhitelist,
  assignKeyToUser,
  insertLicenses,
} from "../database.js";
import { generateLicenseKey, statusEmoji, durationLabel } from "../utils.js";
import {
  logHwidReset as discordLogHwidReset,
  logWhitelistAdd,
  logTicketRequest,
  logTicketApproved,
  logTicketRejected,
} from "../../lib/discordLogger.js";
import { logger } from "../../lib/logger.js";

const LUA_SCRIPT = `loadstring(game:HttpGet("https://xifil-hub-production.up.railway.app/api/lua/loader?game=soul_iron"))()`;

const PERIOD_MS: Record<string, number> = {
  DAILY: 24 * 60 * 60 * 1000,
  WEEKLY: 7 * 24 * 60 * 60 * 1000,
  MONTHLY: 30 * 24 * 60 * 60 * 1000,
  UNLIMITED: 0,
};

const PERIOD_LABEL: Record<string, string> = {
  DAILY: "Per Hari",
  WEEKLY: "Per Minggu",
  MONTHLY: "Per Bulan",
  UNLIMITED: "Tanpa Cooldown",
};

export async function handleButton(interaction: ButtonInteraction): Promise<void> {
  const { customId } = interaction;

  if (customId === "get_role_vip") {
    await handleGetRoleVip(interaction);
  } else if (customId === "get_key") {
    await handleGetKey(interaction);
  } else if (customId === "reset_hwid") {
    await handleResetHwidButton(interaction);
  } else if (customId === "cek_hwid") {
    await handleCekHwid(interaction);
  } else if (customId === "request_akses_vip") {
    await handleRequestAksesVip(interaction);
  } else if (customId === "get_script") {
    await handleGetScript(interaction);
  } else if (customId.startsWith("approve_ticket_")) {
    await handleApproveTicket(interaction);
  } else if (customId.startsWith("reject_ticket_")) {
    await handleRejectTicket(interaction);
  }
}

// ─── Whitelist Check Helper ────────────────────────────────────────────────

async function requireWhitelist(interaction: ButtonInteraction): Promise<boolean> {
  const entry = await getWhitelistUser(interaction.user.id);
  if (!entry) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xd50000)
          .setTitle("❌ Tidak Terdaftar di Whitelist")
          .setDescription(
            "Fitur ini memerlukan whitelist VIP.\nGunakan tombol **Request Akses** atau hubungi admin."
          )
          .setTimestamp(),
      ],
    });
    return false;
  }
  return true;
}

// ─── Get Role VIP ─────────────────────────────────────────────────────────

async function handleGetRoleVip(interaction: ButtonInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  if (!(await requireWhitelist(interaction))) return;

  const entry = await getWhitelistUser(interaction.user.id);
  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply({ content: "Perintah ini hanya bisa digunakan di server." });
    return;
  }

  const vipRoleName = process.env["VIP_ROLE_NAME"] ?? "VIP";
  const vipRole = guild.roles.cache.find((r) => r.name === vipRoleName);

  if (!vipRole) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xd50000)
          .setTitle("❌ Role Tidak Ditemukan")
          .setDescription(`Role **${vipRoleName}** tidak ada di server. Minta admin buat role itu.`)
          .setTimestamp(),
      ],
    });
    return;
  }

  const member = interaction.member as GuildMember;
  if (member.roles.cache.has(vipRole.id)) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xff6d00)
          .setTitle("⚠️ Sudah Punya Role VIP")
          .setDescription(`Kamu sudah memiliki role **${vipRoleName}**!`)
          .setTimestamp(),
      ],
    });
    return;
  }

  try {
    await member.roles.add(vipRole, "Whitelist VIP claim via panel");
    await setVipRoleAssigned(interaction.user.id);

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x00c853)
          .setTitle("🎖️ Role VIP Berhasil Diklaim!")
          .setDescription(
            `Selamat <@${interaction.user.id}>! Kamu mendapatkan role **${vipRoleName}**.\nGunakan tombol **Get Key** untuk mengambil license key kamu.`
          )
          .addFields({ name: "Jumlah Key", value: `${entry!.key_count} key`, inline: true })
          .setTimestamp(),
      ],
    });
  } catch (err) {
    logger.error({ err }, "Failed to assign VIP role");
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xd50000)
          .setTitle("❌ Gagal Memberikan Role")
          .setDescription(
            "Bot tidak bisa memberikan role.\nPastikan posisi role bot **di atas** role VIP di pengaturan server."
          )
          .setTimestamp(),
      ],
    });
  }
}

// ─── Get Key ──────────────────────────────────────────────────────────────

async function handleGetKey(interaction: ButtonInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  if (!(await requireWhitelist(interaction))) return;

  const userKeys = await getUserKeys(interaction.user.id);

  if (userKeys.length === 0) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xff6d00)
          .setTitle("🔑 Tidak Ada Key")
          .setDescription("Kamu belum memiliki key. Hubungi admin.")
          .setTimestamp(),
      ],
    });
    return;
  }

  const fields: { name: string; value: string; inline: boolean }[] = [];
  for (const uk of userKeys.slice(0, 10)) {
    const license = await getByKey(uk.license_key);
    if (!license) continue;

    let expiryText = "Permanent ♾️";
    if (license.duration_type !== "PERMANENT" && license.expires_at) {
      const now = Date.now();
      expiryText = now > license.expires_at ? "❌ Expired" : `<t:${Math.floor(license.expires_at / 1000)}:R>`;
    } else if (license.status === "UNUSED") {
      expiryText = "⏳ Belum diaktifkan";
    }

    fields.push({
      name: `${statusEmoji(license.status)} \`${uk.license_key}\``,
      value: `**Status:** ${license.status} • **Tipe:** ${durationLabel(license.duration_type, license.duration_value)}\n**Expired:** ${expiryText}${license.label ? `\n📝 *${license.label}*` : ""}`,
      inline: false,
    });
  }

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(0x00c853)
        .setTitle(`🔑 Key Kamu (${userKeys.length} key)`)
        .setDescription("Berikut license key yang terdaftar untuk akun kamu:")
        .addFields(fields)
        .setFooter({ text: "License Manager • Jaga kerahasiaan key kamu!" })
        .setTimestamp(),
    ],
  });
}

// ─── Reset HWID (Modal trigger) ───────────────────────────────────────────

async function handleResetHwidButton(interaction: ButtonInteraction): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId("reset_hwid_modal")
    .setTitle("🔄 Reset HWID");

  const keyInput = new TextInputBuilder()
    .setCustomId("hwid_key_input")
    .setLabel("Masukkan License Key kamu")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setPlaceholder("XXXX-XXXX-XXXX-XXXX")
    .setMinLength(19)
    .setMaxLength(19);

  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(keyInput));
  await interaction.showModal(modal);
}

// ─── Reset HWID Modal Submit ──────────────────────────────────────────────

export async function handleResetHwidModal(interaction: ModalSubmitInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const entry = await getWhitelistUser(interaction.user.id);
  if (!entry) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xd50000)
          .setTitle("❌ Tidak Terdaftar di Whitelist")
          .setDescription("Fitur ini memerlukan whitelist VIP. Hubungi admin.")
          .setTimestamp(),
      ],
    });
    return;
  }

  const key = interaction.fields.getTextInputValue("hwid_key_input").trim().toUpperCase();
  const license = await getByKey(key);

  if (!license) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder().setColor(0xd50000).setTitle("❌ Key Tidak Ditemukan").setTimestamp(),
      ],
    });
    return;
  }

  if (license.status === "REVOKED") {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder().setColor(0xd50000).setTitle("❌ Key Dicabut").setTimestamp(),
      ],
    });
    return;
  }

  if (!license.hwid_hash) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xff6d00)
          .setTitle("⚠️ Tidak Ada HWID")
          .setDescription("Key ini belum terikat ke perangkat manapun.")
          .setTimestamp(),
      ],
    });
    return;
  }

  const userKeys = await getUserKeys(interaction.user.id);
  if (!userKeys.some((uk) => uk.license_key === key)) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xd50000)
          .setTitle("❌ Bukan Key Milikmu")
          .setDescription("Kamu hanya bisa reset HWID key milik kamu sendiri.")
          .setTimestamp(),
      ],
    });
    return;
  }

  if (license.max_hwid_resets !== -1 && license.hwid_reset_count >= license.max_hwid_resets) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xd50000)
          .setTitle("❌ Batas Reset Tercapai")
          .setDescription(`Batas maksimal **${license.max_hwid_resets}x** reset sudah tercapai.\nHubungi admin.`)
          .setTimestamp(),
      ],
    });
    return;
  }

  const period = license.hwid_reset_period ?? "WEEKLY";
  const periodMs = PERIOD_MS[period] ?? PERIOD_MS["WEEKLY"]!;

  if (periodMs > 0) {
    const lastReset = await getLastHwidReset(interaction.user.id, key);
    const now = Date.now();
    if (lastReset) {
      const nextResetTime = lastReset.reset_at + periodMs;
      if (now < nextResetTime) {
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xff6d00)
              .setTitle("⏳ Cooldown Aktif")
              .setDescription(
                `Kamu bisa reset HWID lagi pada <t:${Math.floor(nextResetTime / 1000)}:F> (<t:${Math.floor(nextResetTime / 1000)}:R>).\n\n**Periode:** ${PERIOD_LABEL[period] ?? period}`
              )
              .setTimestamp(),
          ],
        });
        return;
      }
    }
  }

  const now = Date.now();
  await resetHwidAndIncrementCount(key);
  await logHwidReset({ id: randomUUID(), discordUserId: interaction.user.id, licenseKey: key, resetAt: now });
  await discordLogHwidReset(key, interaction.user.id, false);

  const resetsDone = license.hwid_reset_count + 1;
  const maxLabel = license.max_hwid_resets === -1 ? "∞" : String(license.max_hwid_resets);
  let nextResetText = "Kapan saja (tanpa cooldown)";
  if (periodMs > 0) nextResetText = `<t:${Math.floor((now + periodMs) / 1000)}:R>`;

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(0x00c853)
        .setTitle("✅ HWID Berhasil Direset")
        .setDescription("Key kamu bisa diaktifkan di perangkat baru sekarang.")
        .addFields(
          { name: "Key", value: `\`${key}\``, inline: false },
          { name: "Total Reset", value: `${resetsDone}/${maxLabel}`, inline: true },
          { name: "Reset Berikutnya", value: nextResetText, inline: true }
        )
        .setFooter({ text: `License Manager • Periode: ${PERIOD_LABEL[period] ?? period}` })
        .setTimestamp(),
    ],
  });
}

// ─── Cek HWID ─────────────────────────────────────────────────────────────

async function handleCekHwid(interaction: ButtonInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  if (!(await requireWhitelist(interaction))) return;

  const userKeys = await getUserKeys(interaction.user.id);
  if (userKeys.length === 0) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xff6d00)
          .setTitle("🔍 Tidak Ada Key")
          .setDescription("Kamu belum memiliki key terdaftar.")
          .setTimestamp(),
      ],
    });
    return;
  }

  const fields: { name: string; value: string; inline: boolean }[] = [];
  for (const uk of userKeys.slice(0, 10)) {
    const license = await getByKey(uk.license_key);
    if (!license) continue;

    const hwidText = license.hwid_hash
      ? `🔒 \`${license.hwid_hash.substring(0, 20)}...\``
      : "🔓 Belum terikat";

    fields.push({
      name: `${statusEmoji(license.status)} \`${uk.license_key}\``,
      value: `**HWID:** ${hwidText}\n**Reset:** ${license.hwid_reset_count}/${license.max_hwid_resets === -1 ? "∞" : license.max_hwid_resets} • Periode: ${PERIOD_LABEL[license.hwid_reset_period] ?? license.hwid_reset_period}`,
      inline: false,
    });
  }

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(0x2196f3)
        .setTitle("🔍 Status HWID Key Kamu")
        .addFields(fields)
        .setFooter({ text: "License Manager • HWID dipotong untuk keamanan" })
        .setTimestamp(),
    ],
  });
}

// ─── Request Akses VIP ────────────────────────────────────────────────────

async function handleRequestAksesVip(interaction: ButtonInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const existing = await getWhitelistUser(interaction.user.id);
  if (existing) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xff6d00)
          .setTitle("⚠️ Sudah Terdaftar di Whitelist")
          .setDescription("Kamu sudah ada di whitelist VIP! Gunakan tombol **Get Key** atau **Get Role VIP**.")
          .setTimestamp(),
      ],
    });
    return;
  }

  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply({ content: "Hanya bisa digunakan di server." });
    return;
  }

  const ticketChannel = guild.channels.cache.find(
    (ch) => ch.isTextBased() && (ch.name.toLowerCase().includes("open-ticket") || ch.name.toLowerCase().includes("ticket"))
  ) as TextChannel | undefined;

  if (!ticketChannel) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xd50000)
          .setTitle("❌ Channel Ticket Tidak Ditemukan")
          .setDescription("Hubungi admin secara langsung untuk request akses VIP.")
          .setTimestamp(),
      ],
    });
    return;
  }

  const thread = await ticketChannel.threads.create({
    name: `request-vip-${interaction.user.username}`,
    autoArchiveDuration: 1440,
    reason: `VIP Access Request by ${interaction.user.tag}`,
  });

  const ticketEmbed = new EmbedBuilder()
    .setColor(0xff9800)
    .setTitle("🎟️ Request Akses VIP")
    .setDescription(`User <@${interaction.user.id}> meminta akses VIP.\n\nAdmin, silakan **Approve** atau **Reject** request ini.`)
    .addFields(
      { name: "User", value: `<@${interaction.user.id}>`, inline: true },
      { name: "Username", value: interaction.user.username, inline: true },
      { name: "ID", value: interaction.user.id, inline: true }
    )
    .setTimestamp();

  const ticketRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`approve_ticket_${interaction.user.id}`)
      .setLabel("✅ Approve")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`reject_ticket_${interaction.user.id}`)
      .setLabel("❌ Reject")
      .setStyle(ButtonStyle.Danger)
  );

  await thread.send({ embeds: [ticketEmbed], components: [ticketRow] });
  await logTicketRequest(interaction.user.id, interaction.user.username);

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(0x00c853)
        .setTitle("🎟️ Request Terkirim!")
        .setDescription(
          "Request akses VIP kamu sudah dikirim ke admin.\nTunggu persetujuan, kamu akan mendapat notifikasi via DM."
        )
        .setTimestamp(),
    ],
  });
}

// ─── Ticket Approve ───────────────────────────────────────────────────────

async function handleApproveTicket(interaction: ButtonInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: false });

  const member = interaction.member as GuildMember;
  const hasAdmin = member.permissions.has("Administrator");
  if (!hasAdmin) {
    await interaction.editReply({ content: "❌ Hanya admin yang bisa approve ticket." });
    return;
  }

  const targetUserId = interaction.customId.replace("approve_ticket_", "");
  const now = Date.now();

  const key = generateLicenseKey();
  await insertLicenses([
    {
      id: randomUUID(),
      licenseKey: key,
      durationType: "PERMANENT",
      durationValue: 0,
      issuerDiscordId: interaction.user.id,
      createdAt: now,
    },
  ]);

  await addToWhitelist({
    id: randomUUID(),
    discordUserId: targetUserId,
    discordUsername: targetUserId,
    keyCount: 1,
    addedBy: interaction.user.id,
    addedAt: now,
  });

  await assignKeyToUser({
    id: randomUUID(),
    discordUserId: targetUserId,
    licenseKey: key,
    assignedAt: now,
  });

  await logTicketApproved(targetUserId, interaction.user.id);
  await logWhitelistAdd(targetUserId, 1, interaction.user.id);

  try {
    const guild = interaction.guild!;
    const vipRoleName = process.env["VIP_ROLE_NAME"] ?? "VIP";
    const vipRole = guild.roles.cache.find((r) => r.name === vipRoleName);
    const targetMember = await guild.members.fetch(targetUserId).catch(() => null);
    if (targetMember && vipRole) {
      await targetMember.roles.add(vipRole, "Ticket approved");
    }
  } catch { /* role assignment is best-effort */ }

  try {
    const client = interaction.client;
    const targetUser = await client.users.fetch(targetUserId).catch(() => null);
    if (targetUser) {
      await targetUser.send({
        embeds: [
          new EmbedBuilder()
            .setColor(0x00c853)
            .setTitle("✅ Request VIP Disetujui!")
            .setDescription(
              `Selamat! Request akses VIP kamu telah **disetujui** oleh admin.\n\nKamu sekarang sudah terdaftar di whitelist VIP.`
            )
            .addFields({ name: "License Key Kamu", value: `\`${key}\``, inline: false })
            .setFooter({ text: "XiFil Hub • Jaga kerahasiaan key kamu!" })
            .setTimestamp(),
        ],
      });
    }
  } catch { /* DM might be blocked */ }

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(0x00c853)
        .setTitle("✅ Ticket Disetujui")
        .setDescription(`<@${targetUserId}> telah di-whitelist dan mendapat 1 key PERMANENT.\nDM sudah dikirim ke user.`)
        .setTimestamp(),
    ],
  });

  if (interaction.channel instanceof ThreadChannel) {
    await (interaction.channel as ThreadChannel).setArchived(true).catch(() => null);
  }
}

// ─── Ticket Reject ────────────────────────────────────────────────────────

async function handleRejectTicket(interaction: ButtonInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: false });

  const member = interaction.member as GuildMember;
  const hasAdmin = member.permissions.has("Administrator");
  if (!hasAdmin) {
    await interaction.editReply({ content: "❌ Hanya admin yang bisa reject ticket." });
    return;
  }

  const targetUserId = interaction.customId.replace("reject_ticket_", "");

  await logTicketRejected(targetUserId, interaction.user.id);

  try {
    const targetUser = await interaction.client.users.fetch(targetUserId).catch(() => null);
    if (targetUser) {
      await targetUser.send({
        embeds: [
          new EmbedBuilder()
            .setColor(0xd50000)
            .setTitle("❌ Request VIP Ditolak")
            .setDescription("Maaf, request akses VIP kamu ditolak oleh admin.\nHubungi admin untuk informasi lebih lanjut.")
            .setTimestamp(),
        ],
      });
    }
  } catch { /* DM might be blocked */ }

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(0xd50000)
        .setTitle("❌ Ticket Ditolak")
        .setDescription(`Request dari <@${targetUserId}> telah ditolak.`)
        .setTimestamp(),
    ],
  });

  if (interaction.channel instanceof ThreadChannel) {
    await (interaction.channel as ThreadChannel).setArchived(true).catch(() => null);
  }
}

// ─── Get Script ───────────────────────────────────────────────────────────

async function handleGetScript(interaction: ButtonInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("📜 Script Roblox")
        .setDescription("Salin script di bawah ini dan jalankan di executor Roblox kamu:")
        .addFields({
          name: "Script",
          value: `\`\`\`lua\n${LUA_SCRIPT}\n\`\`\``,
          inline: false,
        })
        .setFooter({ text: "XiFil Hub • Jangan bagikan script ini!" })
        .setTimestamp(),
    ],
  });
}
