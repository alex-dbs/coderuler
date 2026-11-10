# frozen_string_literal: true

module CodeRulerRubyLspCompat
  VERSION = "0.26.11"

  module DocumentCoordinates
    def find_index_by_position(start_pos, end_pos = nil)
      start_index, end_index = super
      prefix = @coderuler_utf16_prefix

      unless @coderuler_utf16_prefix_version == version
        prefix = [0]
        source.each_codepoint do |codepoint|
          prefix << prefix[-1] + (codepoint > 0xFFFF ? 2 : 1)
        end
        @coderuler_utf16_prefix = prefix
        @coderuler_utf16_prefix_version = version
      end

      [prefix[start_index], end_index && prefix[end_index]]
    end
  end

  module CommonRanges
    def range_from_node(node)
      range_from_location(node.location)
    end

    def range_from_location(location)
      return super unless location.is_a?(Prism::Location)

      ::RubyLsp::Interface::Range.new(
        start: ::RubyLsp::Interface::Position.new(
          line: location.start_line - 1,
          character: CodeRulerRubyLspCompat.utf16_column(location, :start),
        ),
        end: ::RubyLsp::Interface::Position.new(
          line: location.end_line - 1,
          character: CodeRulerRubyLspCompat.utf16_column(location, :end),
        ),
      )
    end
  end

  module RequestPositions
    private

    def cover?(location, position)
      covers_position?(location, position)
    end

    def covers_position?(location, position)
      return false unless location

      start_line = location.start_line - 1
      end_line = location.end_line - 1
      line = position[:line]
      character = position[:character]

      (start_line < line || (start_line == line && CodeRulerRubyLspCompat.utf16_column(location, :start) <= character)) &&
        (end_line > line || (end_line == line && CodeRulerRubyLspCompat.utf16_column(location, :end) >= character))
    end
  end

  def self.utf16_column(location, edge)
    location.public_send("#{edge}_code_units_column", Encoding::UTF_16LE)
  end

  def self.activate
    return unless defined?(::RubyLsp::VERSION) && ::RubyLsp::VERSION == VERSION
    return if @activated

    @activated = true
    ::RubyLsp::RubyDocument.prepend(DocumentCoordinates)
    ::RubyLsp::Requests::Support::Common.prepend(CommonRanges)
    ::RubyLsp::Requests::Request.prepend(RequestPositions)
  end

  module RequireHook
    def require(feature)
      result = super
      CodeRulerRubyLspCompat.activate if feature == "ruby_lsp/internal"
      result
    end

    private :require
  end
end

Kernel.prepend(CodeRulerRubyLspCompat::RequireHook)
