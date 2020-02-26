import _ from 'lodash';
import irc from 'irc-upd';
import discord from 'discord.js';
import logger from './logger';
import { ConfigurationError } from './errors';
import { validateChannelMapping } from './validators';
import { formatFromDiscordToIRC, formatFromIRCToDiscord } from './formatting';

// Usernames need to be between 2 and 32 characters for webhooks:
const USERNAME_MIN_LENGTH = 2;
const USERNAME_MAX_LENGTH = 32;

const REQUIRED_FIELDS = ['server', 'nickname', 'channelMapping', 'discordToken'];
const NICK_COLORS = ['light_blue', 'dark_blue', 'light_red', 'dark_red', 'light_green',
  'dark_green', 'magenta', 'light_magenta', 'orange', 'yellow', 'cyan', 'light_cyan'];
const patternMatch = /{\$(.+?)}/g;

/**
 * An IRC bot, works as a middleman for all communication
 * @param {object} options - server, nickname, channelMapping, outgoingToken, incomingURL
 */
class Bot {
  constructor(options) {
    REQUIRED_FIELDS.forEach((field) => {
      if (!options[field]) {
        throw new ConfigurationError(`Missing configuration field ${field}`);
      }
    });

    validateChannelMapping(options.channelMapping);

    this.discord = new discord.Client({ autoReconnect: true });

    this.server = options.server;
    this.nickname = options.nickname;
    this.ircOptions = options.ircOptions;
    this.discordToken = options.discordToken;
    this.commandCharacters = options.commandCharacters || [];
    this.ircNickColor = options.ircNickColor !== false; // default to true
    this.parallelPingFix = options.parallelPingFix === true; // default: false
    this.channels = _.values(options.channelMapping);
    if (typeof (options.ircStatusNotices) === 'string') {
      this.ircStatusNotices = options.ircStatusNotices; // custom channel to announce join/quit
    } else {
      // default to false (don't announce)
      this.ircStatusNotices = options.ircStatusNotices || false;
    }
    this.announceSelfJoin = options.announceSelfJoin;
    this.webhookOptions = options.webhooks;

    // Nicks to ignore
    this.ignoreUsers = options.ignoreUsers || {};
    this.ignoreUsers.irc = this.ignoreUsers.irc || [];
    this.ignoreUsers.discord = this.ignoreUsers.discord || [];
    this.ignoreUsers.discordIds = this.ignoreUsers.discordIds || [];

    // "{$keyName}" => "variableValue"
    // author/nickname: nickname of the user who sent the message
    // discordChannel: Discord channel (e.g. #general)
    // ircChannel: IRC channel (e.g. #irc)
    // text: the (appropriately formatted) message content
    this.format = options.format || {};

    // "{$keyName}" => "variableValue"
    // displayUsername: nickname with wrapped colors
    // attachmentURL: the URL of the attachment (only applicable in formatURLAttachment)
    this.formatIRCText = this.format.ircText || '<{$displayUsername}> {$text}';
    this.formatURLAttachment = this.format.urlAttachment || '<{$displayUsername}> {$attachmentURL}';

    // "{$keyName}" => "variableValue"
    // side: "Discord" or "IRC"
    if ('commandPrelude' in this.format) {
      this.formatCommandPrelude = this.format.commandPrelude;
    } else {
      this.formatCommandPrelude = 'Command sent from {$side} by {$nickname}:';
    }

    // "{$keyName}" => "variableValue"
    // withMentions: text with appropriate mentions reformatted
    this.formatDiscord = this.format.discord || '**<{$author}>** {$withMentions}';

    // "{$keyName} => "variableValue"
    // nickname: nickame of IRC message sender
    this.formatWebhookAvatarURL = this.format.webhookAvatarURL;

    // Keep track of { channel => [list, of, usernames] } for ircStatusNotices
    this.channelUsers = {};

    this.channelMapping = {};
    this.webhooks = {};

    // Remove channel passwords from the mapping and lowercase IRC channel names
    _.forOwn(options.channelMapping, (ircChan, discordChan) => {
      this.channelMapping[discordChan] = ircChan.split(' ')[0].toLowerCase();
    });

    this.invertedMapping = _.invert(this.channelMapping);
    this.autoSendCommands = options.autoSendCommands || [];
  }

  connect() {
    logger.debug('Connecting to IRC and Discord');
    this.discord.login(this.discordToken);

    // Extract id and token from Webhook urls and connect.
    _.forOwn(this.webhookOptions, (url, channel) => {
      const [id, token] = url.split('/').slice(-2);
      const client = new discord.WebhookClient(id, token);
      this.webhooks[channel] = {
        id,
        client
      };
    });

    const ircOptions = {
      userName: this.nickname,
      realName: this.nickname,
      channels: this.channels,
      floodProtection: true,
      floodProtectionDelay: 500,
      retryCount: 10,
      autoRenick: true,
      // options specified in the configuration file override the above defaults
      ...this.ircOptions
    };

    // default encoding to UTF-8 so messages to Discord aren't corrupted
    if (!Object.prototype.hasOwnProperty.call(ircOptions, 'encoding')) {
      if (irc.canConvertEncoding()) {
        ircOptions.encoding = 'utf-8';
      } else {
        logger.warn('Cannot convert message encoding; you may encounter corrupted characters with non-English text.\n' +
          'For information on how to fix this, please see: https://github.com/Throne3d/node-irc#character-set-detection');
      }
    }

    this.ircClient = new irc.Client(this.server, this.nickname, ircOptions);
    this.attachListeners();
  }

  attachListeners() {
    this.discord.on('ready', () => {
      logger.info('Connected to Discord');
    });

    this.ircClient.on('registered', (message) => {
      logger.info('Connected to IRC');
      logger.debug('Registered event: ', message);
      this.autoSendCommands.forEach((element) => {
        this.ircClient.send(...element);
      });
    });

    this.ircClient.on('error', (error) => {
      logger.error('Received error event from IRC', error);
    });

    this.discord.on('error', (error) => {
      logger.error('Received error event from Discord', error);
    });

    this.discord.on('warn', (warning) => {
      logger.warn('Received warn event from Discord', warning);
    });

    this.discord.on('message', (message) => {
      // Ignore bot messages and people leaving/joining
      this.sendToIRC(message);
    });

    this.ircClient.on('message', this.sendToDiscord.bind(this));

    this.ircClient.on('notice', (author, to, text) => {
      this.sendToDiscord(author, to, `*${text}*`);
    });

    this.ircClient.on('nick', (oldNick, newNick, channels) => {
      if (this.ircStatusNotices === false) return;
      channels.forEach((channelName) => {
        const channel = channelName.toLowerCase();
        if (this.channelUsers[channel]) {
          if (this.channelUsers[channel].has(oldNick)) {
            this.channelUsers[channel].delete(oldNick);
            this.channelUsers[channel].add(newNick);
            if (this.ircStatusNotices === true) {
              this.sendExactToDiscordByIrcChannel(channel, `*${oldNick}* is now known as ${newNick}`);
            }
          }
        } else {
          logger.warn(`No channelUsers found for ${channel} when ${oldNick} changed.`);
        }
      });
      if (typeof (this.ircStatusNotices) === 'string') {
        this.sendExactToDiscordByDiscordChannel(this.ircStatusNotices, `*${oldNick}* is now known as ${newNick}`);
      }
    });

    this.ircClient.on('join', (channelName, nick) => {
      logger.debug('Received join:', channelName, nick);
      if (this.ircStatusNotices === false) return;
      if (nick === this.ircClient.nick && !this.announceSelfJoin) return;
      if (this.ircStatusNotices === true) {
        const channel = channelName.toLowerCase();
        // self-join is announced before names (which includes own nick)
        // so don't add nick to channelUsers
        if (nick !== this.ircClient.nick) this.channelUsers[channel].add(nick);
        this.sendExactToDiscordByIrcChannel(channel, `*${nick}* has joined the channel`);
      } else {
        const ircChannel = channelName.toLowerCase();
        const discordChannel = this.ircStatusNotices;
        // Only send the message once per user. Do this by checking channelUsers
        // and sending if user is being added for the first time.
        if (nick !== this.ircClient.nick) {
          let firstAdd = true;
          Object.keys(this.channelUsers).forEach((channel) => {
            if (this.channelUsers[channel].has(nick)) {
              firstAdd = false;
            }
          });
          this.channelUsers[ircChannel].add(nick);
          if (firstAdd) {
            this.sendExactToDiscordByDiscordChannel(discordChannel, `*${nick}* has joined IRC`);
          }
        }
      }
    });

    this.ircClient.on('part', (channelName, nick, reason) => {
      logger.debug('Received part:', channelName, nick, reason);
      if (this.ircStatusNotices === false) return;
      const channel = channelName.toLowerCase();
      // remove list of users when no longer in channel (as it will become out of date)
      if (nick === this.ircClient.nick) {
        logger.debug('Deleting channelUsers as bot parted:', channel);
        delete this.channelUsers[channel];
        return;
      }
      if (this.channelUsers[channel]) {
        this.channelUsers[channel].delete(nick);
      } else {
        logger.warn(`No channelUsers found for ${channel} when ${nick} parted.`);
      }
      if (typeof (this.ircStatusNotices) === 'string') {
        this.sendExactToDiscordByDiscordChannel(this.ircStatusNotices, `*${nick}* has left ${channel} (${reason})`);
      } else if (this.ircStatusNotices === true) {
        this.sendExactToDiscordByIrcChannel(channel, `*${nick}* has left the channel (${reason})`);
      }
    });

    this.ircClient.on('quit', (nick, reason, channels) => {
      logger.debug('Received quit:', nick, channels);
      if (this.ircStatusNotices === false || nick === this.ircClient.nick) return;
      channels.forEach((channelName) => {
        const channel = channelName.toLowerCase();
        if (!this.channelUsers[channel]) {
          logger.warn(`No channelUsers found for ${channel} when ${nick} quit, ignoring.`);
          return;
        }
        if (!this.channelUsers[channel].delete(nick)) return;
        if (this.ircStatusNotices === true) {
          this.sendExactToDiscordByIrcChannel(channel, `*${nick}* has quit (${reason})`);
        }
      });
      if (typeof (this.ircStatusNotices) === 'string') {
        this.sendExactToDiscordByDiscordChannel(this.ircStatusNotices, `*${nick}* has quit (${reason})`);
      }
    });

    this.ircClient.on('names', (channelName, nicks) => {
      logger.debug('Received names:', channelName, nicks);
      if (!this.ircStatusNotices) return;
      const channel = channelName.toLowerCase();
      this.channelUsers[channel] = new Set(Object.keys(nicks));
    });

    this.ircClient.on('action', (author, to, text) => {
      this.sendToDiscord(author, to, `_${text}_`);
    });

    this.ircClient.on('invite', (channel, from) => {
      logger.debug('Received invite:', channel, from);
      if (!this.invertedMapping[channel]) {
        logger.debug('Channel not found in config, not joining:', channel);
      } else {
        this.ircClient.join(channel);
        logger.debug('Joining channel:', channel);
      }
    });

    if (logger.level === 'debug') {
      this.discord.on('debug', (message) => {
        logger.debug('Received debug event from Discord', message);
      });
    }
  }

  static getDiscordNicknameOnServer(user, guild) {
    if (guild) {
      const userDetails = guild.members.get(user.id);
      if (userDetails) {
        return userDetails.nickname || user.username;
      }
    }
    return user.username;
  }

  parseText(message) {
    const text = message.mentions.users.reduce((content, mention) => {
      const displayName = Bot.getDiscordNicknameOnServer(mention, message.guild);
      return content.replace(`<@${mention.id}>`, `@${displayName}`)
        .replace(`<@!${mention.id}>`, `@${displayName}`)
        .replace(`<@&${mention.id}>`, `@${displayName}`);
    }, message.content);

    return text
      .replace(/\n|\r\n|\r/g, ' ')
      .replace(/<#(\d+)>/g, (match, channelId) => {
        const channel = this.discord.channels.get(channelId);
        if (channel) return `#${channel.name}`;
        return '#deleted-channel';
      })
      .replace(/<@&(\d+)>/g, (match, roleId) => {
        const role = message.guild.roles.get(roleId);
        if (role) return `@${role.name}`;
        return '@deleted-role';
      })
      .replace(/<a?(:\w+:)\d+>/g, (match, emoteName) => emoteName);
  }

  isCommandMessage(message) {
    return this.commandCharacters.some(prefix => message.startsWith(prefix));
  }

  ignoredIrcUser(user) {
    return this.ignoreUsers.irc.some(i => i.toLowerCase() === user.toLowerCase());
  }

  ignoredDiscordUser(discordUser) {
    const ignoredName = this.ignoreUsers.discord.some(
      i => i.toLowerCase() === discordUser.username.toLowerCase()
    );
    const ignoredId = this.ignoreUsers.discordIds.some(i => i === discordUser.id);
    return ignoredName || ignoredId;
  }

  static substitutePattern(message, patternMapping) {
    return message.replace(patternMatch, (match, varName) => patternMapping[varName] || match);
  }

  sendToIRC(message) {
    const { author } = message;
    // Ignore messages sent by the bot itself:
    if (author.id === this.discord.user.id ||
        Object.keys(this.webhooks).some(channel => this.webhooks[channel].id === author.id)
    ) return;

    // Do not send to IRC if this user is on the ignore list.
    if (this.ignoredDiscordUser(author)) {
      return;
    }

    const channelName = `#${message.channel.name}`;
    const ircChannel = this.channelMapping[message.channel.id] ||
                                           this.channelMapping[channelName];

    logger.debug('Channel Mapping', channelName, this.channelMapping[channelName]);
    if (ircChannel) {
      const fromGuild = message.guild;
      const nickname = Bot.getDiscordNicknameOnServer(author, fromGuild);
      let text = this.parseText(message);
      let displayUsername = nickname;

      if (this.parallelPingFix) {
        // Prevent users of both IRC and Discord from
        // being mentioned in IRC when they talk in Discord.
        displayUsername = `${displayUsername.slice(0, 1)}\u200B${displayUsername.slice(1)}`;
      }

      if (this.ircNickColor) {
        const colorIndex = (nickname.charCodeAt(0) + nickname.length) % NICK_COLORS.length;
        displayUsername = irc.colors.wrap(NICK_COLORS[colorIndex], displayUsername);
      }

      const patternMap = {
        author: nickname,
        nickname,
        displayUsername,
        text,
        discordChannel: channelName,
        ircChannel
      };

      if (this.isCommandMessage(text)) {
        patternMap.side = 'Discord';
        logger.debug('Sending command message to IRC', ircChannel, text);
        // if (prelude) this.ircClient.say(ircChannel, prelude);
        if (this.formatCommandPrelude) {
          const prelude = Bot.substitutePattern(this.formatCommandPrelude, patternMap);
          this.ircClient.say(ircChannel, prelude);
        }
        this.ircClient.say(ircChannel, text);
      } else {
        if (text !== '') {
          // Convert formatting
          text = formatFromDiscordToIRC(text);
          patternMap.text = text;

          text = Bot.substitutePattern(this.formatIRCText, patternMap);
          logger.debug('Sending message to IRC', ircChannel, text);
          this.ircClient.say(ircChannel, text);
        }

        if (message.attachments && message.attachments.size) {
          message.attachments.forEach((a) => {
            patternMap.attachmentURL = a.url;
            const urlMessage = Bot.substitutePattern(this.formatURLAttachment, patternMap);

            logger.debug('Sending attachment URL to IRC', ircChannel, urlMessage);
            this.ircClient.say(ircChannel, urlMessage);
          });
        }
      }
    }
  }

  findDiscordChannel(ircChannel) {
    const discordChannelName = this.invertedMapping[ircChannel.toLowerCase()];
    if (discordChannelName) {
      // #channel -> channel before retrieving and select only text channels:
      let discordChannel = null;

      if (this.discord.channels.has(discordChannelName)) {
        discordChannel = this.discord.channels.get(discordChannelName);
      } else if (discordChannelName.startsWith('#')) {
        discordChannel = this.discord.channels
          .filter(c => c.type === 'text')
          .find(c => c.name === discordChannelName.slice(1));
      }

      if (!discordChannel) {
        logger.info(
          'Tried to send a message to a channel the bot isn\'t in: ',
          discordChannelName
        );
        return null;
      }
      return discordChannel;
    }
    return null;
  }

  findWebhook(ircChannel) {
    const discordChannelName = this.invertedMapping[ircChannel.toLowerCase()];
    return discordChannelName && this.webhooks[discordChannelName];
  }

  getDiscordAvatar(nick, channel) {
    const guildMembers = this.findDiscordChannel(channel).guild.members;
    const findByNicknameOrUsername = caseSensitive =>
      (member) => {
        if (caseSensitive) {
          return member.user.username === nick || member.nickname === nick;
        }
        const nickLowerCase = nick.toLowerCase();
        return member.user.username.toLowerCase() === nickLowerCase
          || (member.nickname && member.nickname.toLowerCase() === nickLowerCase);
      };

    // Try to find exact matching case
    let users = guildMembers.filter(findByNicknameOrUsername(true));

    // Now let's search case insensitive.
    if (users.size === 0) {
      users = guildMembers.filter(findByNicknameOrUsername(false));
    }

    // No matching user or more than one => default avatar
    if (users && users.size === 1) {
      const url = users.first().user.avatarURL;
      if (url) return url.replace(/\?size=\d{1,}$/, '?size=128');
    }

    // If there isn't a URL format, don't send an avatar at all
    if (this.formatWebhookAvatarURL) {
      return Bot.substitutePattern(this.formatWebhookAvatarURL, { nickname: nick });
    }
    return null;
  }

  // compare two strings case-insensitively
  // for discord mention matching
  static caseComp(str1, str2) {
    return str1.toUpperCase() === str2.toUpperCase();
  }

  // check if the first string starts with the second case-insensitively
  // for discord mention matching
  static caseStartsWith(str1, str2) {
    return str1.toUpperCase().startsWith(str2.toUpperCase());
  }

  sendToDiscord(author, channel, text) {
    const discordChannel = this.findDiscordChannel(channel);
    if (!discordChannel) return;

    // Do not send to Discord if this user is on the ignore list.
    if (this.ignoredIrcUser(author)) {
      return;
    }

    // Convert text formatting (bold, italics, underscore)
    const withFormat = formatFromIRCToDiscord(text);

    const patternMap = {
      author,
      nickname: author,
      displayUsername: author,
      text: withFormat,
      discordChannel: `#${discordChannel.name}`,
      ircChannel: channel
    };

    if (this.isCommandMessage(text)) {
      patternMap.side = 'IRC';
      logger.debug('Sending command message to Discord', `#${discordChannel.name}`, text);
      if (this.formatCommandPrelude) {
        const prelude = Bot.substitutePattern(this.formatCommandPrelude, patternMap);
        discordChannel.send(prelude);
      }
      discordChannel.send(text);
      return;
    }

    const { guild } = discordChannel;
    const withMentions = withFormat.replace(/@([^\s#]+)#(\d+)/g, (match, username, discriminator) => {
      // @username#1234 => mention
      // skips usernames including spaces for ease (they cannot include hashes)
      // checks case insensitively as Discord does
      const user = guild.members.find(x =>
        Bot.caseComp(x.user.username, username)
        && x.user.discriminator === discriminator);
      if (user) return user;

      return match;
    }).replace(/^([^@\s:,]+)[:,]|@([^\s]+)/g, (match, startRef, atRef) => {
      const reference = startRef || atRef;

      // this preliminary stuff is ultimately unnecessary
      // but might save time over later more complicated calculations
      // @nickname => mention, case insensitively
      const nickUser = guild.members.find(x =>
        x.nickname !== null && Bot.caseComp(x.nickname, reference));
      if (nickUser) return nickUser;

      // @username => mention, case insensitively
      const user = guild.members.find(x => Bot.caseComp(x.user.username, reference));
      if (user) return user;

      // @role => mention, case insensitively
      const role = guild.roles.find(x => x.mentionable && Bot.caseComp(x.name, reference));
      if (role) return role;

      // No match found checking the whole word. Check for partial matches now instead.
      // @nameextra => [mention]extra, case insensitively, as Discord does
      // uses the longest match, and if there are two, whichever is a match by case
      let matchLength = 0;
      let bestMatch = null;
      let caseMatched = false;

      // check if a partial match is found in reference and if so update the match values
      const checkMatch = function (matchString, matchValue) {
        // if the matchString is longer than the current best and is a match
        // or if it's the same length but it matches by case unlike the current match
        // set the best match to this matchString and matchValue
        if ((matchString.length > matchLength && Bot.caseStartsWith(reference, matchString))
          || (matchString.length === matchLength && !caseMatched
              && reference.startsWith(matchString))) {
          matchLength = matchString.length;
          bestMatch = matchValue;
          caseMatched = reference.startsWith(matchString);
        }
      };

      // check users by username and nickname
      guild.members.forEach((member) => {
        checkMatch(member.user.username, member);
        if (bestMatch === member || member.nickname === null) return;
        checkMatch(member.nickname, member);
      });
      // check mentionable roles by visible name
      guild.roles.forEach((member) => {
        if (!member.mentionable) return;
        checkMatch(member.name, member);
      });

      // if a partial match was found, return the match and the unmatched trailing characters
      if (bestMatch) return bestMatch.toString() + reference.substring(matchLength);

      return match;
    }).replace(/:(\w+):/g, (match, ident) => {
      // :emoji: => mention, case sensitively
      const emoji = guild.emojis.find(x => x.name === ident && x.requiresColons);
      if (emoji) return emoji;

      return match;
    }).replace(/#([^\s#@'!?,.]+)/g, (match, channelName) => {
      // channel names can't contain spaces, #, @, ', !, ?, , or .
      // (based on brief testing. they also can't contain some other symbols,
      // but these seem likely to be common around channel references)

      // discord matches channel names case insensitively
      const chan = guild.channels.find(x => Bot.caseComp(x.name, channelName));
      return chan || match;
    });

    // Webhooks first
    const webhook = this.findWebhook(channel);
    if (webhook) {
      logger.debug('Sending message to Discord via webhook', withMentions, channel, '->', `#${discordChannel.name}`);
      const permissions = discordChannel.permissionsFor(this.discord.user);
      let canPingEveryone = false;
      if (permissions) {
        canPingEveryone = permissions.has(discord.Permissions.FLAGS.MENTION_EVERYONE);
      }
      const avatarURL = this.getDiscordAvatar(author, channel);
      const username = _.padEnd(author.substring(0, USERNAME_MAX_LENGTH), USERNAME_MIN_LENGTH, '_');
      webhook.client.sendMessage(withMentions, {
        username,
        text,
        avatarURL,
        disableEveryone: !canPingEveryone,
      }).catch(logger.error);
      return;
    }

    patternMap.withMentions = withMentions;

    // Add bold formatting:
    // Use custom formatting from config / default formatting with bold author
    const withAuthor = Bot.substitutePattern(this.formatDiscord, patternMap);
    logger.debug('Sending message to Discord', withAuthor, channel, '->', `#${discordChannel.name}`);
    discordChannel.send(withAuthor);
  }

  /* Sends a message to Discord exactly as it appears in the passed IRC channel name */
  sendExactToDiscordByIrcChannel(channel, text) {
    const discordChannel = this.findDiscordChannel(channel);
    if (!discordChannel) return;

    logger.debug('Sending special message to Discord', text, channel, '->', `#${discordChannel.name}`);
    discordChannel.send(text);
  }

  /* Sends a message to Discord exactly as it appears in the passed Discord channel name */
  sendExactToDiscordByDiscordChannel(channel, text) {
    const discordChannel = this.discord.channels
      .filter(c => c.type === 'text')
      .find('name', channel.slice(1));

    if (!discordChannel) {
      logger.info(
        'Tried to send a message to a Discord channel the bot isn\'t in: ',
        channel
      );
      return;
    }

    logger.debug('Sending special message to Discord', text, `#${discordChannel.name}`);
    discordChannel.send(text);
  }
}

export default Bot;
